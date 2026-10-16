# Team Chat

Chat med dine kolleger i et panel lige ved siden af Claude. Intet login: vælg et navn, og deltag i rum med en invitationskode. Del Claudes svar med ét klik.

## Installér

### Med Claude desktop

1. Åbn **Plugins**-fanen i Claude desktop.
2. Indsæt adressen på dette repo, og installér:

   ```
   https://github.com/Stokn9x/Claude_Chat
   ```

3. Start en ny session i Code-fanen. Panelet **💬 Chat** åbner af sig selv.

Opdateringer hentes samme sted, i Plugins-fanen.

### Med Claude Code i terminalen

Start `claude`, og skriv:

```
/plugin install team-chat --marketplace Stokn9x/Claude_Chat
```

Svar `y` til at tilføje marketplacen, og vælg **user**-scope med Enter.

<details>
<summary>Virker Plugins-fanen ikke? Installér og opdatér med PowerShell (Windows)</summary>

Installér:

```powershell
$roots = @("$env:APPDATA\Claude\claude-code") + (Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter "*Claude*" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.FullName)\LocalCache\Roaming\Claude\claude-code" })
$claude = $roots | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Recurse -Filter claude.exe } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $claude) { $claude = (Get-Command claude -ErrorAction SilentlyContinue).Source }
if ($claude) { "Fandt: $claude"; & $claude plugin marketplace add Stokn9x/Claude_Chat; & $claude plugin install team-chat@team-chat } else { "Fandt ingen claude.exe" }
```

Står der *Fandt ingen claude.exe*, så åbn Code-fanen i Claude desktop og start én session, og kør blokken igen. Start derefter en ny session i Code-fanen.

Opdatér, og start en ny session bagefter:

```powershell
$roots = @("$env:APPDATA\Claude\claude-code") + (Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter "*Claude*" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.FullName)\LocalCache\Roaming\Claude\claude-code" })
$claude = $roots | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Recurse -Filter claude.exe } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $claude) { $claude = (Get-Command claude -ErrorAction SilentlyContinue).Source }
if ($claude) { & $claude plugin marketplace update team-chat; & $claude plugin update team-chat@team-chat; & $claude plugin list } else { "Fandt ingen claude.exe" }
```

</details>

## Kom i gang

1. Panelet **💬 Chat** åbner af sig selv (ellers skriv `/chat`).
2. Skriv det navn, dine kolleger skal se.
3. **Opret et rum**, og send koden (fx `HAV7-K2PQ`) til dine kolleger med **🔗 Inviter → Kopiér invitation**, eller **deltag** i et rum med en kode, du har fået.

## Kommandoer

| Kommando | Gør |
| --- | --- |
| `/chat` | Åbner chatpanelet |
| `/chat hej med jer` | Sender en besked til det aktive rum |
| `/chat HAV7-K2PQ` eller `/chat deltag HAV7-K2PQ` | Deltager i et rum |
| `/chat rum Projekt X` | Opretter et nyt rum |
| `/chat kode` | Viser det aktive rums kode |
| `/chat navn Amalie` | Skifter dit navn i alle dine rum |
| `/chat forlad` | Forlader det aktive rum |

## Sikkerhed

- Hver computer får en anonym konto i Supabase. Kun medlemmer af et rum kan læse og skrive i det (Row Level Security), og man bliver kun medlem med rummets kode.
- Afsender og navn sættes af serveren, så ingen kan skrive i en andens navn, og hvert navn findes kun én gang pr. rum.
- Koden er nøglen til rummet: del den kun med dem, der skal være med.
- Intet fra chatten sendes videre til Claude.

## Backend

Databasen (tabeller, funktioner og regler) ligger i [`supabase/schema.sql`](supabase/schema.sql). Projektet skal have *Allow anonymous sign-ins* slået til.
