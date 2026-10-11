# HviK – Desktop-App

Die Desktop-App der **HviK Community**: [hvik.org](https://hvik.org) als eigenes Windows-Programm – mit Discord-Login, eigener Titelleiste und automatischen Updates.

**Download:** unter [Releases](https://github.com/Bukaas/HviK-App/releases/latest) die Datei `HviK-Setup-….exe` laden und starten.
Windows zeigt evtl. „Der Computer wurde durch Windows geschützt“ (die App ist nicht signiert) → *Weitere Informationen → Trotzdem ausführen*.

## Entwickeln

```
npm install
npm start          # App starten
npm run dist       # Installer bauen (dist/)
```

Ein neues Release (Version in `package.json` erhöhen) mit `HviK-Setup-<version>.exe`, `.blockmap` und `latest.yml` als Assets –
die installierten Apps holen sich das Update dann von selbst.
