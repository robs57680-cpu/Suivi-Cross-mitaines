Box Score — ressources graphiques externalisées

- index.html : application avec les images raster extraites et référencées depuis assets/embedded/.
- assets/embedded/ : images qui étaient intégrées en base64 dans le HTML.

IMPORTANT : le HTML original importe aussi ./firebase-config.js et référence manifest.webmanifest et icon-180.png.
Ces fichiers doivent rester à la racine du dépôt GitHub, comme dans votre projet actuel.
Les chemins sont relatifs et prévus pour GitHub Pages à la racine du site.

Les images sont nommées image_XX par ordre d'apparition dans le code. Leur contenu/qualité binaire est conservé sans recompression.
