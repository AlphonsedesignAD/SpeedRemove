import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Node.js 22+, no dependencies, no database, no files written by the upload handler.
const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.REMOVE_BG_API_KEY;
const configuredOrigin = process.env.PUBLIC_ORIGIN;
const size = process.env.REMOVE_BG_SIZE || 'preview';
const MAX_BODY = 10 * 1024 * 1024 + 128 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_RESPONSE = 40 * 1024 * 1024;
const staticRoot = fileURLToPath(new URL('./public/', import.meta.url));
const page = await readFile(staticRoot + 'index.html');
const rates = new Map();
let active = 0, used = 0, usageWindow = Date.now();
const hourlyBudget = Math.max(1, Number(process.env.MAX_REQUESTS_PER_HOUR || 30));
if (!KEY) { console.error('Configurez REMOVE_BG_API_KEY avant de démarrer. Consultez README.md.'); process.exit(1); }
if (!['preview', 'auto', 'full'].includes(size)) throw new Error('REMOVE_BG_SIZE doit valoir preview, auto ou full.');
setInterval(() => { const now=Date.now(); for(const [ip,record] of rates) if(now-record.start>60000)rates.delete(ip); },60000).unref();

function json(res, status, error) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify({error}));
}
function sameOrigin(req) {
  // Use PUBLIC_ORIGIN behind a reverse proxy. Do not trust forwarded headers.
  const expected = configuredOrigin || `http://${req.headers.host}`;
  return req.headers.origin === expected;
}
function looksLikeImage(buffer, type) {
  if(type==='image/png') return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(type==='image/jpeg') return buffer[0]===255 && buffer[1]===216 && buffer[2]===255;
  if(type==='image/webp') return buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP';
  return false;
}
async function bodyBytes(req) {
  const chunks=[];let total=0;
  for await(const chunk of req){ total+=chunk.length; if(total>MAX_BODY)throw Object.assign(new Error('Fichier trop volumineux.'),{status:413}); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  const path=(req.url||'/').split('?')[0];
  if((req.method==='GET'||req.method==='HEAD')&&(path==='/'||path==='/index.html')){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:page);return;
  }
  if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(path!=='/api/remove-background')return json(res,404,'Page introuvable.');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return json(res,405,'Méthode non autorisée.');}
  if(!sameOrigin(req))return json(res,403,'Requête non autorisée.');
  if(!String(req.headers['content-type']||'').startsWith('multipart/form-data;'))return json(res,400,'Une image est requise.');
  const length=Number(req.headers['content-length']||0);
  if(length>MAX_BODY)return json(res,413,'Cette image dépasse 10 Mo.');
  const ip=req.socket.remoteAddress || 'unknown', now=Date.now();
  const bucket=rates.get(ip)||{start:now,count:0};
  if(now-bucket.start>60000){bucket.start=now;bucket.count=0;}
  if(bucket.count>=5){res.setHeader('Retry-After','60');return json(res,429,'Trop de demandes. Patientez une minute.');}
  bucket.count++;rates.set(ip,bucket);
  if(now-usageWindow>=3600000){used=0;usageWindow=now;}
  if(used>=hourlyBudget)return json(res,429,'Le quota horaire du site est atteint. Réessayez plus tard.');
  if(active>=3)return json(res,503,'Le service est occupé. Réessayez dans un instant.');
  active++;
  try {
    const bytes=await bodyBytes(req);
    let data;
    try { data=await new Request('http://localhost/upload',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:bytes}).formData(); }
    catch {return json(res,400,'Le fichier envoyé est invalide.');}
    const images=data.getAll('image_file');
    const file=images[0];
    if(images.length!==1 || !file || typeof file==='string' || !file.size)return json(res,400,'Choisissez une seule image.');
    if(file.size>MAX_FILE)return json(res,413,'Cette image dépasse 10 Mo.');
    if(!['image/jpeg','image/png','image/webp'].includes(file.type))return json(res,415,'Choisissez une image JPG, PNG ou WebP.');
    const image=Buffer.from(await file.arrayBuffer());
    if(!looksLikeImage(image,file.type))return json(res,415,'Le contenu du fichier ne correspond pas au format annoncé.');
    // Rebuild form data so callers cannot inject their own API parameters.
    const form=new FormData();form.append('image_file',new Blob([image],{type:file.type}),'image');form.append('size',size);form.append('format','png');
    used++; // Counts attempts, not successful results: protects the account's budget.
    const upstream=await fetch('https://api.remove.bg/v1.0/removebg',{method:'POST',headers:{'X-Api-Key':KEY},body:form,signal:AbortSignal.timeout(55000)});
    if(!upstream.ok){
      await upstream.body?.cancel();
      const messages={400:'Cette image ne peut pas être traitée. Essayez une autre photo.',402:'Le compte remove.bg n’a plus assez de crédits.',403:'La clé remove.bg est invalide ou désactivée.',429:'remove.bg reçoit trop de demandes. Réessayez plus tard.'};
      return json(res,[400,402,429].includes(upstream.status)?upstream.status:502,messages[upstream.status]||'Le service de détourage est indisponible.');
    }
    if(!upstream.headers.get('content-type')?.startsWith('image/png')) {await upstream.body?.cancel();return json(res,502,'Réponse inattendue du service de détourage.');}
    const chunks=[];let total=0;
    for await(const chunk of upstream.body){total+=chunk.length;if(total>MAX_RESPONSE)throw new Error('Réponse trop volumineuse.');chunks.push(chunk);}
    res.writeHead(200,{'Content-Type':'image/png','Content-Disposition':'attachment; filename="speedremove.png"','Cache-Control':'no-store'});res.end(Buffer.concat(chunks));
  } catch(e) {
    if(res.destroyed||res.writableEnded)return;
    json(res,e.status||504,e.status?e.message:'Le traitement a été interrompu. Réessayez plus tard.');
  } finally {active--;}
});
server.requestTimeout=70000;
server.headersTimeout=15000;
server.listen(PORT,'0.0.0.0',()=>console.log(`SpeedRemove : http://localhost:${PORT}`));
