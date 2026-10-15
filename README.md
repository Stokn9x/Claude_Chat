# Team Chat

Chat med dine kolleger i et panel lige ved siden af Claude: rum, invitationer og deling af Claudes svar med ét klik.

## Installér

### Med Claude desktop (Windows)

Åbn **PowerShell**, og indsæt hele blokken:

```powershell
$roots = @("$env:APPDATA\Claude\claude-code") + (Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter "*Claude*" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.FullName)\LocalCache\Roaming\Claude\claude-code" })
$claude = $roots | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Recurse -Filter claude.exe } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $claude) { $claude = (Get-Command claude -ErrorAction SilentlyContinue).Source }
if ($claude) { "Fandt: $claude"; & $claude plugin marketplace add Stokn9x/Claude_Chat; & $claude plugin install team-chat@team-chat } else { "Fandt ingen claude.exe" }
```

Står der *Fandt ingen claude.exe*, så åbn Code-fanen i Claude desktop og start én session, og kør blokken igen. Start derefter en ny session i Code-fanen.

### Med Claude Code i terminalen

Start `claude`, og skriv:

```
/plugin install team-chat --marketplace Stokn9x/Claude_Chat
```

Svar `y` til at tilføje marketplacen, og vælg **user**-scope med Enter.

### Opdatér

```
claude plugin marketplace update team-chat
```

## Kom i gang

1. Panelet **💬 Chat** åbner af sig selv (ellers skriv `/chat`).
2. Log ind på én af to måder:
   - **Invitationsnøgle:** har du fået en nøgle (`tc1:…`), så indsæt den i *Har du fået en invitationsnøgle?* og tryk Enter.
   - **E-mail:** skriv din e-mail og tryk Enter. Du får en mail fra Supabase. **Klik ikke på linket.** Højreklik på det, vælg *Kopiér link*, og indsæt det i panelet.
3. Opret et rum med **＋ Nyt rum**, eller bed en kollega invitere dig.

## Kommandoer

| Kommando | Gør |
| --- | --- |
| `/chat` | Åbner chatpanelet |
| `/chat tc1:…` | Logger ind med en invitationsnøgle |
| `/chat hej med jer` | Sender en besked til det aktive rum |
| `/chat inviter navn@firma.dk` | Inviterer en kollega til rummet |
| `/chat rum Projekt X` | Opretter et nyt rum |
| `/chat navn Amalie` | Ændrer dit visningsnavn |
| `/chat log ud` | Logger ud |

## Sikkerhed

- Beskeder ligger i Supabase, og kun medlemmer af et rum kan læse og skrive i det (Row Level Security).
- Man kan kun skrive som sig selv; afsenderen tages fra login'et.
- En invitationsnøgle er personlig og virker som en adgangskode: send den privat, og bed om en ny, hvis den er blevet delt.
- Intet fra chatten sendes videre til Claude.
