# SpeedRemove

Site en français pour importer une photo, supprimer automatiquement son fond via remove.bg et télécharger le PNG transparent. Aucun compte utilisateur, aucune base de données, aucune écriture des photos sur disque par le serveur.

## Démarrage

1. Installez Node.js 22 ou une version plus récente.
2. Ouvrez un terminal dans le dossier SpeedRemove extrait.
3. Copiez `.env.example` vers `.env` : `cp .env.example .env` (Windows PowerShell : `Copy-Item .env.example .env`).
4. Dans `.env`, remplacez `remplacez_par_votre_cle_remove_bg` par votre clé remove.bg. La clé fournie dans la conversation n’est volontairement pas incluse dans les fichiers téléchargeables.
5. Lancez `npm start`. Aucun `npm install` n’est nécessaire.
6. Ouvrez `http://localhost:3000`, importez une image, attendez le résultat puis cliquez sur « Télécharger le PNG ».

## Hébergement

Il faut un hébergement capable d’exécuter Node.js. Un hébergement de fichiers statiques seul ne suffit pas à protéger une clé partagée. Le serveur est un relais de quelques centaines de lignes, pas une base de données.

Configurez les mêmes variables dans l’interface de votre hébergeur, puis lancez `node server.mjs`. Utilisez HTTPS et renseignez `PUBLIC_ORIGIN` avec l’origine exacte du site, sans slash final, par exemple `https://speedremove.votre-domaine.fr`. Ne déployez pas `.env` dans un répertoire public. Le fichier n’est jamais servi par ce serveur.

## Crédits et protection

`REMOVE_BG_SIZE=preview` est la valeur par défaut : elle réduit la résolution du résultat. Les quotas et la facturation sont ceux de votre compte remove.bg. Pour une meilleure résolution, utilisez `auto` ou `full` après vérification de vos crédits.

Les demandes sont limitées à 5 par minute et par adresse réseau, 3 traitements simultanés et 30 tentatives par heure pour le site entier. Ajustez ce dernier seuil avec `MAX_REQUESTS_PER_HOUR`. Ces compteurs sont temporaires, en mémoire, et repartent à zéro au redémarrage. Ils ne constituent pas une protection absolue contre un abus d’un service public. Avant une ouverture à grande échelle, ajoutez une protection anti-bot et des quotas côté hébergeur. Derrière un proxy, la limite par adresse peut s’appliquer à l’adresse du proxy ; le budget global reste actif. Ne faites pas confiance à des en-têtes transférés sans configuration de proxy sûre.

Le serveur accepte uniquement JPG, PNG et WebP jusqu’à 10 Mo. Le navigateur vérifie également les 25 mégapixels maximum. remove.bg vérifie les dimensions et la validité de l’image. Les fichiers ne sont pas conservés par SpeedRemove ; ils sont néanmoins transmis à remove.bg et soumis à sa politique de confidentialité. Évitez d’importer des images sensibles sans vérifier cette politique.

## Fichiers

`public/index.html` : interface responsive, import par clic ou glisser-déposer, aperçu local, traitement automatique, erreurs explicites, téléchargement.

`server.mjs` : relais sécurisé par origine, clé en variable d’environnement, vérification du format, limites et délais.

`.env.example` : configuration à compléter.

`package.json` : commande de démarrage sans dépendances externes.

`.gitignore` : exclusion des secrets.

## Tests et limites

L’interface et les validations locales ont été vérifiées dans l’aperçu. Le vrai appel remove.bg n’a pas été exécuté ici : l’environnement de création ne dispose pas d’accès internet pour le serveur. La validité de la clé et le solde de crédits restent à vérifier à votre premier traitement réel. L’exemple de plante est une illustration prédécoupée, pas un détourage effectué par l’API.

Documentation remove.bg : https://www.remove.bg/api

Si votre clé a été partagée dans un espace accessible à d’autres personnes, révoquez-la et générez-en une nouvelle avant la mise en ligne.
