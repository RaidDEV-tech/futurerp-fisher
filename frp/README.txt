FutureRP Fisher — hosten & auto-update via GitHub
=================================================
app/      Windows-app          server/  keys + admin + telefoon-remote
website/  downloadsite         .github/ automatische builds

EENMALIG
1. Maak op github.com een PUBLIEKE repo "futurerp-fisher" en push deze map erheen.
   (Publiek is nodig zodat de app updates kan ophalen. Keys en wachtwoord staan niet in de repo.)
2. Vervang JOUW_GITHUB_NAAM in app/package.json en website/index.html.
3. Repo -> Settings -> Pages -> Source: "GitHub Actions".
4. Server draait NIET op GitHub. Gebruik bv. Render.com: "New Web Service" -> koppel je repo,
   Root directory: server, Build: npm install, Start: node server.js.
   Zet omgevingsvariabelen: ADMIN_PASSWORD=<jouw wachtwoord>, DATA_FILE=/data/data.json
   en koppel een Persistent Disk op /data (anders raak je je keys kwijt bij een herstart).
   Elke push naar GitHub deployt de server daarna vanzelf opnieuw.
5. Zet het server-adres in app/config.json ("serverUrl") en commit.

DAARNA, ELKE KEER DAT JE IETS AANPAST IN VS CODE
- Website:  git push (naar main)  -> binnen ~1 min live op GitHub Pages
- Server:   git push               -> Render deployt automatisch
- App/exe:  git commit + push, daarna:
              git tag v3.0.1
              git push --tags
            GitHub bouwt de exe, zet hem in Releases, en de downloadknop op de website
            wijst altijd naar de nieuwste versie. Geïnstalleerde apps vinden de update bij
            het opstarten en vragen om te herstarten.
   Het versienummer is steeds hoger dan het vorige (v3.0.1, v3.0.2, ...).

LOKAAL TESTEN: cd server && npm install && ADMIN_PASSWORD=iets node server.js
