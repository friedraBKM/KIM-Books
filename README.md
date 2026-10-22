# Must-Read-Regal der KI Masterclass

Eine kleine Web-App für eine Buchumfrage. Teilnehmende nennen anonym bis zu drei Bücher, die ihr Leben verändert haben, jeweils mit einem Satz dazu, warum. Daraus entsteht eine Rangliste, die sich nach Kategorien filtern lässt.

## Was die App kann

- **Eintragen** (`/`): Titel oder Autor suchen und das richtige Buch aus der Trefferliste wählen. Gesucht wird zuerst im eigenen Regal, also unter den Büchern, die schon genannt wurden; erst danach in Google Books bzw. Open Library. Bücher aus dem Regal lassen sich mit einem Klick übernehmen. Wird ein Buch nicht gefunden, kann man Titel und Autor selbst eintragen.
- **Amazon-Links:** Ein Klick auf den Titel öffnet das Buch bei Amazon. Ist die ISBN bekannt (Treffer aus Google Books), führt der Link genau zu dieser Ausgabe (`amazon.de/dp/<ISBN-10>`), bei mehreren Ausgaben eines Werks zur deutschen mit den meisten Nennungen. Für manuell eingetragene Bücher sucht die App die ISBN selbst (Deutsche Nationalbibliothek, Google Books, Open Library): Bei genau einem eindeutigen Treffer (Titel und Autor stimmen, eine ISBN) wird der Link automatisch gesetzt, sonst erscheint im Admin ein Vorschlag zum Übernehmen. Bis dahin bzw. ohne Treffer gibt es eine Amazon-Suche. Im Admin lässt sich pro Buch eine ISBN festlegen.
- **Ergebnisse** (`/ergebnisse`): Kennzahlen, Rangliste mit Zähler und Balken, Filter nach Kategorie, „Warum“-Sätze zum Aufklappen und „In meine Top 3“. Die Seite aktualisiert sich alle 20 Sekunden. Der Präsentationsmodus zeigt alles groß an (auch direkt über `/ergebnisse?praesentation=1`).
- **Admin** (`/admin`, Benutzer `admin`):
  - Status des KI-Abgleichs.
  - Manuell eingetragene Bücher prüfen und bestätigen.
  - Zusammenführungen der KI ansehen und bei Bedarf trennen.
  - Kategorien korrigieren und Bücher löschen.
  - Markierte „Warum“-Sätze freigeben oder ausblenden.
  - CSV-Export.
- **KI-Abgleich** (Claude): Läuft automatisch 30 Sekunden nach der letzten Abgabe. Er erledigt drei Dinge:
  - Er führt gleiche Werke zusammen (Original und Übersetzung, andere Ausgaben).
  - Er bildet 5 bis 8 Kategorien.
  - Er markiert unpassende „Warum“-Sätze.

  Ohne API-Key werden nur Bücher mit gleichem Titel und gleichem Autor zusammengelegt, und es gibt keine Kategorien.
- **Benachrichtigung:** Bei manuell eingetragenen Büchern kommt eine E-Mail und/oder eine Webhook-Nachricht. Mehrere Einträge innerhalb von 2 Minuten werden gebündelt.
- **Daten bleiben erhalten:** Alles liegt in einer SQLite-Datei unter `/data`. Ist dieser Ordner als Volume eingebunden, überstehen die Daten jedes Redeploy.

## Einrichtung in Coolify

1. **Neue Ressource:** In Coolify *+ New → Public/Private Repository* wählen und `https://github.com/friedraBKM/KIM-Books` eintragen. Branch `main`, Build Pack **Dockerfile**.
2. **Port:** Unter *General → Ports Exposes* `3000` eintragen und die gewünschte Domain setzen. HTTPS übernimmt Coolify.
3. **Persistenter Speicher (wichtig!):** Unter *Persistent Storage → + Add → Volume Mount*:
   - Name: `kim-books-data`
   - Destination Path: `/data`

   Ohne diesen Schritt sind die Daten nach jedem Redeploy weg.
4. **Umgebungsvariablen:** Unter *Environment Variables* die Werte aus der Tabelle unten eintragen. Mindestens `ADMIN_PASSWORD`, `APP_SECRET` und `ACCESS_CODE` setzen.
5. **Deploy** klicken. Danach `https://deine-domain/healthz` aufrufen. Es sollte `{"ok":true}` erscheinen.
6. **Test:** Seite öffnen, Zugangscode eingeben, ein Buch eintragen, unter `/admin` mit `admin` und deinem Passwort anmelden.

**Daten bei Updates:**
- Alle Daten liegen im Volume `/data`. Ein Redeploy ersetzt nur den Programmcode, nicht dieses Volume.
- Änderungen an der Datenbank werden nur ergänzend gemacht (neue Spalten), es wird nie etwas gelöscht oder umgebaut.
- Bei jedem Start legt die App vorher eine Sicherung unter `/data/backups` an; die letzten 20 bleiben erhalten.
- Im Start-Log steht „Datenbestand: X Teilnehmende, Y Nennungen“. So siehst du nach jedem Deploy sofort, ob alles da ist.
- Im Admin lädt „Datenbank sichern“ eine vollständige Kopie herunter. Das solltest du vor jedem größeren Update tun.


## Umgebungsvariablen

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `ADMIN_PASSWORD` | ja | Passwort für `/admin` (Benutzername `admin`) |
| `APP_SECRET` | ja | Lange Zufallszeichenkette, z. B. aus einem Passwortgenerator mit 40 Zeichen. Nie ändern, sonst müssen alle den Code neu eingeben und können ihre Auswahl nicht mehr bearbeiten |
| `ACCESS_CODE` | empfohlen | Zugangscode für die Teilnehmenden. Leer bedeutet: die Seite ist offen für alle mit dem Link |
| `GOOGLE_BOOKS_API_KEY` | empfohlen | Für die Buchsuche (siehe unten). Ohne Key wird nur Open Library genutzt |
| `OPENLIBRARY_CONTACT` | nein | Deine E-Mail; Open Library erlaubt damit mehr Anfragen |
| `ANTHROPIC_API_KEY` | empfohlen | Für den KI-Abgleich (siehe unten) |
| `ANTHROPIC_MODEL` | nein | Standard `claude-opus-5-5`. Günstiger, aber weniger gründlich: `claude-haiku-5-5` |
| `AMAZON_PARTNER_TAG` | nein | Amazon-Partner-ID, z. B. `meinname-21`. Dann sind die Amazon-Links standardmäßig Partnerlinks (gekennzeichnet), Besucher können unten auf der Ergebnisseite auf neutrale Links umstellen. Leer = immer neutrale Links |
| `NOTIFY_EMAIL` | nein | Empfänger für Hinweise auf manuelle Einträge |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | nein | Postausgangsserver für diese E-Mails |
| `NOTIFY_WEBHOOK_URL` | nein | Alternativ oder zusätzlich: Webhook, z. B. ntfy.sh oder ein Teams-/Slack-Webhook (erhält `{"text": "..."}`) |
| `PUBLIC_URL` | nein | Öffentliche Adresse, für den Link in der Benachrichtigung |
| `PRIVACY_CONTACT` | empfohlen | Name und Kontakt der verantwortlichen Person für den Datenschutzhinweis |
| `RECONCILE_DELAY_SECONDS` | nein | Wartezeit vor dem KI-Abgleich, Standard 30 |

## API-Keys besorgen

**Google Books** (kostenlos):

1. Auf https://console.cloud.google.com mit einem Google-Konto anmelden und ein Projekt anlegen, z. B. „KIM-Books“.
2. *APIs & Services → Library* → „Books API“ suchen → *Enable*.
3. *APIs & Services → Credentials → Create credentials → API key*.
4. Empfohlen: Den Key unter *API restrictions* auf „Books API“ beschränken.
5. Den Key in Coolify als `GOOGLE_BOOKS_API_KEY` eintragen.

**Anthropic** (kostenpflichtig, nach Verbrauch):

1. Auf https://console.anthropic.com anmelden und unter *Billing* Guthaben aufladen.
2. *API Keys → Create Key*.
3. Den Key in Coolify als `ANTHROPIC_API_KEY` eintragen.
4. Empfohlen: Im Workspace ein monatliches Ausgabenlimit setzen.

Nach dem Eintragen der Keys einmal **Redeploy** (oder *Restart*) in Coolify.

## Lokal ausprobieren

Voraussetzung ist Node.js ab Version 22.13.

```bash
npm install
cp .env.example .env    # Werte anpassen
node --env-file=.env --disable-warning=ExperimentalWarning src/server.js
# http://localhost:3000
npm test                # prüft die Übernahme des KI-Ergebnisses
```

## Datenschutz in Kürze

- Die App speichert keine Namen, E-Mail-Adressen oder IP-Adressen. Doppelte Abgaben verhindert eine zufällige Browser-Kennung, die nur verschlüsselt gespeichert wird.
- Buchsuche und Cover laufen über den eigenen Server. Die Browser der Teilnehmenden haben keinen Kontakt zu Google, und Schriften werden lokal ausgeliefert, also ohne Google Fonts.
- An Anthropic gehen nur Buchangaben und die „Warum“-Sätze, ohne Kennung. Anthropic ist ein US-Anbieter; das steht im Datenschutzhinweis unter `/datenschutz`.
- Den Text unter `views/datenschutz.html` vor dem Start prüfen und `PRIVACY_CONTACT` setzen.

## Aufbau

```
src/server.js   Routen, Abgabe, Ergebnisse, Admin
src/search.js   Suche im Regal, Google Books, Open Library
src/ai.js       KI-Abgleich (Zusammenführen, Kategorien, Moderation)
src/db.js       SQLite-Schema
src/notify.js   E-Mail/Webhook bei manuellen Einträgen
views/          HTML-Seiten
public/         CSS und JavaScript im Browser
```
