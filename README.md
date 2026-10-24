# Serveur de déclarations d'absences – UM6SS · FM6SIPS Dakhla

## Pourquoi un serveur ?
Le téléphone d'un enseignant doit pouvoir **écrire** dans votre application. Une page qui ne vit que dans le navigateur de l'administration (ou un lien `localhost`) ne peut pas recevoir cela. Ce petit serveur :

* héberge l'application d'administration (`public/index.html`) **et** le formulaire mobile (`public/form.html`) ;
* crée des **liens uniques par séance** (jeton aléatoire de 192 bits, stocké uniquement sous forme de hachage SHA-256), avec **expiration** et **révocation** ;
* n'expose à l'enseignant que la **liste des étudiants du groupe de la séance** (nom + matricule) ;
* enregistre les déclarations (absents, matricules, remarque, signature, date/heure, statut) et conserve l'**historique des corrections** ;
* protège l'administration par un **mot de passe** (cookie HttpOnly, SameSite=Strict, limitation des tentatives).

Aucune dépendance : **Node.js 18 ou plus récent** suffit.

## Démarrage
```bash
# Linux / macOS
ADMIN_PASSWORD="choisissez-un-mot-de-passe-long" PUBLIC_URL="https://absences.votre-domaine.ma" node server.js

# Windows (PowerShell)
$env:ADMIN_PASSWORD="choisissez-un-mot-de-passe-long"; $env:PUBLIC_URL="https://absences.votre-domaine.ma"; node server.js
```
Le serveur **refuse de démarrer sans `ADMIN_PASSWORD`** (8 caractères minimum, aucun mot de passe par défaut).

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_PASSWORD` | mot de passe de l'administration (obligatoire) | – |
| `PORT` | port d'écoute | `8787` |
| `DATA_DIR` | dossier des données (`store.json`, `secret.key`) | `./data` |
| `PUBLIC_URL` | adresse publique utilisée dans les liens envoyés | déduite de la requête |
| `TRUST_PROXY=1` | à activer derrière un reverse proxy (IP réelle, https) | désactivé |

## Mise en ligne (HTTPS obligatoire pour des liens envoyés à l'extérieur)
Placez le serveur derrière un reverse proxy HTTPS, par exemple avec Caddy :
```
absences.votre-domaine.ma {
    reverse_proxy localhost:8787
}
```
puis lancez avec `TRUST_PROXY=1` et `PUBLIC_URL=https://absences.votre-domaine.ma`. Un hébergement Node (VPS, Render, Railway…) ou le `Dockerfile` fourni conviennent aussi (montez un volume sur `/data`).

## Utilisation
1. Ouvrez l'adresse du serveur, connectez-vous.
2. **Étudiants** → importez le fichier Excel (matricule, nom, prénom, filière, année, groupe).
3. Sur une séance (Timetable Editor ou Today's Schedule) → **Envoyer la liste des absences** → *Envoyer le lien par WhatsApp* : WhatsApp s'ouvre avec le message prérempli, **vous validez l'envoi dans WhatsApp** (l'application ne peut pas envoyer à votre place).
4. L'enseignant ouvre le lien sur son téléphone, coche les absents (ou « Aucun étudiant absent »), signe et valide.
5. **Absences** → consultez, filtrez, corrigez (avec motif), exportez en Excel.

## Sauvegarde
Copiez régulièrement le dossier `data/`. Les **séances, enseignants, étudiants et modèles** de l'application restent, eux, dans le stockage du navigateur de l'administrateur (comme avant) : utilisez les exports Excel pour les sauvegarder. Seules les déclarations et les liens sont centralisés sur le serveur.

## Limites connues
* Un seul compte administrateur (mot de passe partagé).
* Stockage en fichier JSON : adapté à un établissement, pas à des milliers de déclarations par jour (passer à une base de données si besoin).
* L'envoi WhatsApp automatique nécessiterait l'API officielle WhatsApp Business (non incluse).
* La signature « tactile » est une image du tracé ; la « confirmation électronique » est une case + nom saisi et n'est pas une signature manuscrite (elle est étiquetée comme telle).

## Règles métier appliquées par le serveur (heure du Maroc, Africa/Casablanca)
* **Fenêtre de déclaration** : l'enseignant ne peut pas déclarer avant l'heure de début de la séance (heure du serveur) ; le formulaire l'indique clairement.
* **Délai de modification** : 24 h à partir de la première confirmation (horodatage serveur). Par enseignant, l'administration peut **bloquer dès la confirmation**, **accorder une exception avec date d'expiration** ou la **révoquer** (effet immédiat). Toute modification exige un motif ; anciennes valeurs conservées.
* **Alerte de non-déclaration** : une tâche du serveur (toutes les 30 s, même navigateur fermé) crée **une seule alerte par séance** dès l'heure de fin, sans délai de grâce ; elle se résout automatiquement à la déclaration (et reste dans l'historique) ; jamais pour une séance annulée ou reportée. Le serveur connaît les séances grâce à la synchronisation automatique envoyée par l'application d'administration.
* **Heures** : conversion par les données IANA (`Intl`), jamais de décalage fixe : le passage à GMT+0 pendant le Ramadan est géré.
* **Journal d'audit du serveur** : chaîné par hachage (toute modification du fichier est détectée) ; aucun point d'accès ne permet de le modifier ou de le supprimer.
* **Notifications administration** : absences enregistrées, « aucun absent », modification, exception ; état lu / non lu.

## Variables réservées aux tests (ne jamais activer en production)
`ALLOW_TEST_CLOCK=1` (horloge simulée), `ALLOW_EARLY=1` (autorise la déclaration avant le début), `ALERT_INTERVAL_MS` (fréquence de la surveillance).

## Tests
`node tests/rules.test.js` exécute 38 vérifications du serveur (fenêtre, délai de 24 h, exceptions, double envoi simultané, alertes à l'heure de fin y compris Ramadan, notifications, chaîne d'audit, accès refusés).

## Limites de cette version
Pas encore de comptes individuels ni de rôles (un seul mot de passe administrateur), pas de base de données SQL, pas de rémunération. Voir le rapport de phase pour la suite.
