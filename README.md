# Team Chat

Chat med dine kolleger i et panel lige ved siden af Claude: rum, invitationer og deling af Claudes svar med ét klik.

## Installér

Åbn en terminal, start `claude`, og skriv:

```
/plugin install team-chat --marketplace GITHUB-BRUGER/team-chat
```

Svar `y` til at tilføje marketplacen, og vælg **user**-scope med Enter. Herefter er chatten med i alle dine Claude-sessioner, også i Claude desktop-appens Code-fane.

## Kom i gang

1. Panelet **💬 Chat** åbner af sig selv (ellers skriv `/chat`).
2. Skriv din e-mail (den samme som din Claude-konto) og tryk Enter.
3. Du får en mail fra Supabase. **Klik ikke på linket.** Højreklik på det, vælg *Kopiér link*, og indsæt det i panelet.
4. Opret et rum med **＋ Nyt rum**, eller bed en kollega invitere dig.

## Kommandoer

| Kommando | Gør |
| --- | --- |
| `/chat` | Åbner chatpanelet |
| `/chat hej med jer` | Sender en besked til det aktive rum |
| `/chat inviter navn@firma.dk` | Inviterer en kollega til rummet |
| `/chat rum Projekt X` | Opretter et nyt rum |
| `/chat navn Amalie` | Ændrer dit visningsnavn |
| `/chat log ud` | Logger ud |

## Sikkerhed

- Beskeder ligger i Supabase, og kun medlemmer af et rum kan læse og skrive i det (Row Level Security).
- Man kan kun skrive som sig selv; afsenderen tages fra login'et.
- Intet fra chatten sendes videre til Claude.
