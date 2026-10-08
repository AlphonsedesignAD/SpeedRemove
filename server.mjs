import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

try {
  loadEnvFile(
    fileURLToPath(new URL('./.env', import.meta.url))
  );
} catch (error) {
  if (error.code === 'ENOENT') {
    console.warn(
      'Fichier .env absent : utilisation des variables de l’hébergeur.'
    );
  } else {
    throw error;
  }
}


Pour que Vercel inclue ce fichier dans la fonction, crée vercel.json à côté de server.mjs avec :



{
  "functions": {
    "server.mjs": {
      "includeFiles": ".env"
    }
  }
}