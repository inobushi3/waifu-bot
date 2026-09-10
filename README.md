# waifu-bot 🎨

Bot de Discord que recebe `/gerar` e usa um ComfyUI local para gerar imagens.

## Setup rápido

```powershell
git pull
npm install
copy .env.example .env
```

Preencha `.env` com:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
COMFY_URL=http://127.0.0.1:8188
WORKFLOW_PATH=./workflow_api.json
```

Exporte seu workflow do ComfyUI em formato API e salve na raiz como `workflow_api.json`.

Depois rode:

```powershell
npm start
```

No Discord:

```text
/gerar prompt: 1girl, white hair, cat ears, gaming room
```

O bot também aceita `negativo` e `seed` opcionais.
