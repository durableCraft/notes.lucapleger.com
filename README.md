# Notizzettel

Ein selbst gehostetes Notiz-Tool: Beim Öffnen liegt immer ein frischer Zettel bereit – einfach losschreiben.

- **Ohne Anmeldung** bleiben die Zettel nur auf dem Gerät (im Browser). Als App auf dem Home-Bildschirm
  (PWA) funktioniert das auch ohne Verbindung.
- **Mit Anmeldung** liegen die Zettel auf dem Server und sind auf allen Geräten gleich. Auf dem Gerät
  wird dann nichts gespeichert.
- Formatierung: fett, kursiv, unterstrichen. Verlauf nach Tagen, Papierkorb (30 Tage), hell und dunkel.
- Anmeldung mit Passwort oder Passkey, optional mit Code per E-Mail. Neue Zugänge vergibt der Admin.

Technik: Node.js mit Express, eingebautes `node:sqlite`, keine nativen Pakete, kein Build-Schritt.
`node_modules/` ist eingecheckt – auf dem Server ist **kein `npm install`** nötig.

---

## Inhalt

1. [Voraussetzungen](#voraussetzungen)
2. [Installation](#installation)
3. [Konfiguration](#konfiguration)
4. [Dienst mit systemd](#dienst-mit-systemd)
5. [NGINX Proxy Manager](#nginx-proxy-manager)
6. [Ersteinrichtung](#ersteinrichtung)
7. [E-Mail (SMTP, Brevo)](#e-mail-smtp-brevo)
8. [Update](#update)
9. [Backup und Wiederherstellung](#backup-und-wiederherstellung)
10. [Notfall-Zugang](#notfall-zugang)
11. [Kommandozeile](#kommandozeile)
12. [Lokal ausprobieren](#lokal-ausprobieren)
13. [Lizenz](#lizenz)

---

## Voraussetzungen

- Debian (z. B. als LXC-Container unter Proxmox)
- **Node.js 22.13 oder neuer** und `git`

```bash
node --version
```

Läuft im Container schon eine andere Node-Website, prüfe vor einem Node-Update, ob sie mit der neuen
Version zurechtkommt. Notizzettel läuft als **eigener Dienst mit eigenem Port** daneben.

Falls Node.js fehlt oder zu alt ist (Debian selbst bringt eine ältere Version mit), z. B. über NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
```

```bash
bash /tmp/nodesource_setup.sh && apt-get install -y nodejs git
```

---

## Installation

Alle Befehle als `root`.

**1. Dienst-Benutzer anlegen** (ohne Login, ohne Home-Verzeichnis):

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin notizzettel
```

**2. Repository klonen** (Branch `main` ist der stabile Stand):

```bash
git clone --branch main https://github.com/durableCraft/notes.lucapleger.com.git /opt/notizzettel
```

**3. Datenverzeichnis anlegen** – nur der Dienst-Benutzer darf hinein:

```bash
install -d -o notizzettel -g notizzettel -m 700 /opt/notizzettel/data
```

Der Programmcode gehört `root` und ist für den Dienst nur lesbar. Schreiben darf er ausschließlich in
`data/`.

**4. Konfiguration anlegen** (siehe [Konfiguration](#konfiguration)):

```bash
install -o notizzettel -g notizzettel -m 600 /opt/notizzettel/config.example.json /opt/notizzettel/data/config.json
```

```bash
nano /opt/notizzettel/data/config.json
```

Ohne diesen Schritt legt der Dienst beim ersten Start selbst eine `config.json` an – dann aber nur für
`127.0.0.1` und `http://localhost:3100`.

---

## Konfiguration

Datei: `data/config.json`

```json
{
  "port": 3100,
  "host": "0.0.0.0",
  "baseUrl": "https://notes.lucapleger.com",
  "trustProxy": "192.168.1.20",
  "disable2fa": false
}
```

| Einstellung  | Bedeutung |
|--------------|-----------|
| `port`       | Port des Dienstes. Muss frei sein (nicht der Port der anderen Website). |
| `host`       | Bind-Adresse. `0.0.0.0`, wenn NGINX Proxy Manager in einem **anderen** Container läuft; `127.0.0.1`, wenn er im selben Container läuft. |
| `baseUrl`    | Öffentliche Adresse **ohne** `/` am Ende. Wird für Links in E-Mails und als Passkey-Domain verwendet. |
| `trustProxy` | Wem der Dienst die Kopfzeilen `X-Forwarded-For`/`-Proto` glaubt. Am besten die **IP des NGINX-Proxy-Manager-Containers** eintragen (z. B. `"192.168.1.20"`). `true` vertraut jedem – dann sollte der Port nur für den Proxy erreichbar sein, sonst lässt sich das Rate-Limit umgehen. |
| `disable2fa` | Notfall-Schalter: `true` schaltet den Code per E-Mail ab, unabhängig von der Admin-Oberfläche. Wirkt sofort, ohne Neustart. |

Wichtig: Passkeys sind an die Domain aus `baseUrl` gebunden. Ändert sich die Domain, müssen alle
Passkeys neu angelegt werden.

Optional: Port per Firewall nur für den Proxy öffnen, z. B. mit `nftables` oder der Proxmox-Firewall
(nur Zugriff von der IP des NGINX-Proxy-Manager-Containers auf Port 3100).

---

## Dienst mit systemd

Die Unit liegt im Repository unter `deploy/notizzettel.service`.

Pfad von Node prüfen – steht dort nicht `/usr/bin/node`, `ExecStart` in der Unit anpassen:

```bash
command -v node
```

```bash
cp /opt/notizzettel/deploy/notizzettel.service /etc/systemd/system/
```

```bash
systemctl daemon-reload && systemctl enable --now notizzettel
```

```bash
systemctl status notizzettel
```

Protokoll ansehen:

```bash
journalctl -u notizzettel -f
```

In der Unit sind weitere Abschottungs-Optionen vorbereitet, aber auskommentiert. Sie brauchen in einem
unprivilegierten LXC die Container-Option `nesting=1`. Startet der Dienst damit nicht
(`status=226/NAMESPACE`), bleiben sie auskommentiert.

---

## NGINX Proxy Manager

Unter **Hosts → Proxy Hosts → Add Proxy Host**:

**Reiter „Details“**

| Feld                  | Wert |
|-----------------------|------|
| Domain Names          | `notes.lucapleger.com` |
| Scheme                | `http` |
| Forward Hostname / IP | IP des Notizzettel-Containers (z. B. `192.168.1.30`) |
| Forward Port          | `3100` (bzw. der Port aus `config.json`) |
| Cache Assets          | aus |
| Block Common Exploits | an |
| Websockets Support    | nicht nötig |

**Reiter „SSL“**

- SSL Certificate: *Request a new SSL Certificate* (Let's Encrypt)
- **Force SSL**: an
- **HTTP/2 Support**: an
- HSTS: an (empfohlen, sobald alles läuft)

Weitere Einträge unter „Advanced“ sind nicht nötig – NGINX Proxy Manager setzt `X-Forwarded-For` und
`X-Forwarded-Proto` selbst. Wichtig ist nur, dass `trustProxy` in `config.json` passt (siehe oben).
Sonst sieht der Dienst bei allen Anfragen nur die IP des Proxys, und das Rate-Limit für Anmeldungen
würde alle Benutzer gemeinsam bremsen.

---

## Ersteinrichtung

Solange es noch keinen Benutzer gibt, schreibt der Dienst bei jedem Start ein einmaliges
**Setup-Token** ins Protokoll:

```bash
journalctl -u notizzettel -n 30 --no-pager
```

Dann `https://notes.lucapleger.com/setup` öffnen, Token eingeben und das erste Konto anlegen – es wird
Admin. Ohne Token kann niemand Fremdes die Instanz übernehmen. Danach gibt es keine offene
Registrierung mehr: neue Zugänge legt der Admin unter **Verwaltung** an oder verschickt Einladungen.

---

## E-Mail (SMTP, Brevo)

E-Mails werden für Einladungen, „Passwort vergessen“ und den Anmelde-Code gebraucht. Einrichtung in der
Oberfläche unter **Verwaltung → E-Mail**:

| Feld            | Brevo |
|-----------------|-------|
| Server          | `smtp-relay.brevo.com` |
| Port            | `587` |
| Verschlüsselung | STARTTLS |
| Benutzer        | SMTP-Login aus Brevo (*SMTP & API → SMTP*) |
| Passwort        | SMTP-Schlüssel aus Brevo |
| Absender        | z. B. `Notizzettel <notes@lucapleger.com>` – muss in Brevo als Absender bestätigt sein |

Danach **Testmail senden**. Erst nach einer erfolgreichen Testmail lässt sich der Code per E-Mail
(Verwaltung → Sicherheit) einschalten. Jede spätere Änderung an den SMTP-Einstellungen setzt den Code
aus, bis wieder eine Testmail durchgegangen ist – so sperrt eine falsche Einstellung niemanden aus.

Die SMTP-Zugangsdaten liegen nur in der Datenbank in `data/`, nie im Repository.

---

## Update

```bash
cd /opt/notizzettel && git pull && systemctl restart notizzettel
```

Datenbank-Änderungen werden beim Start automatisch übernommen. Vorher ein Backup schadet nie
(siehe unten).

---

## Backup und Wiederherstellung

Alles, was gesichert werden muss, liegt in **`data/`**:

- `notizzettel.db` – Benutzer, Zettel, Passkeys, Einstellungen (inkl. SMTP)
- `config.json` – Konfiguration

**Konsistente Kopie im laufenden Betrieb** (über die SQLite-Backup-Funktion):

```bash
cd /opt/notizzettel && runuser -u notizzettel -- node cli.js backup
```

Das Backup landet unter `data/backups/notizzettel-JJJJMMTT-HHMMSS.db`. Alternativ ein eigenes Ziel
angeben: `node cli.js backup /pfad/zur/datei.db`.

Beispiel für ein tägliches Backup um 3:15 Uhr mit 14 Tagen Aufbewahrung – Datei
`/etc/cron.d/notizzettel-backup`:

```cron
15 3 * * * notizzettel cd /opt/notizzettel && node cli.js backup >/dev/null && find data/backups -name 'notizzettel-*.db' -mtime +14 -delete
```

Zusätzlich empfiehlt sich ein Proxmox-Backup des ganzen Containers.

**Wiederherstellen:**

```bash
systemctl stop notizzettel
```

```bash
install -o notizzettel -g notizzettel -m 600 /pfad/zum/backup.db /opt/notizzettel/data/notizzettel.db
```

```bash
rm -f /opt/notizzettel/data/notizzettel.db-wal /opt/notizzettel/data/notizzettel.db-shm
```

```bash
systemctl start notizzettel
```

---

## Notfall-Zugang

**Code per E-Mail kommt nicht an** (z. B. SMTP gestört): In `data/config.json`
`"disable2fa": true` setzen – wirkt sofort, ohne Neustart. Danach wieder auf `false` stellen.

**Passwort vergessen und keine E-Mail möglich:**

```bash
cd /opt/notizzettel && runuser -u notizzettel -- node cli.js reset-password name@example.com
```

Der Befehl gibt ein neues, zufälliges Passwort aus und meldet das Konto überall ab. Danach unter
„Mein Konto“ ein eigenes Passwort setzen. Ein Admin kann das Passwort auch in der Verwaltung zurücksetzen.

**Admin-Konto deaktiviert oder Rolle verloren:** Das verhindert die Oberfläche – der letzte aktive
Admin lässt sich weder deaktivieren noch herabstufen oder löschen.

---

## Kommandozeile

Als Dienst-Benutzer im Programmverzeichnis ausführen:

| Befehl | Wirkung |
|--------|---------|
| `node cli.js backup [ziel.db]` | konsistente Kopie der Datenbank |
| `node cli.js reset-password <email>` | neues Zufallspasswort setzen und ausgeben |
| `node cli.js users` | alle Benutzer auflisten |
| `node cli.js help` | Hilfe |

---

## Lokal ausprobieren

```bash
node server.js
```

Dann `http://localhost:3100` öffnen; das Setup-Token steht in der Konsole. Passkeys und die App-Funktion
(Service Worker) funktionieren nur über `https://` oder `localhost`, nicht über eine IP-Adresse im LAN.

Umgebungsvariablen für Tests: `PORT`, `HOST`, `BASE_URL`, `NOTIZZETTEL_DATA` (anderes Datenverzeichnis).

---

## Lizenz

© 2026 Luca Pleger. Alle Rechte vorbehalten.
Einsehen erlaubt, keine Nutzung, Veränderung oder Weitergabe ohne Erlaubnis.

Siehe [LICENSE](LICENSE). Mitgelieferte Pakete in `node_modules/` unterliegen ihren eigenen Lizenzen.
