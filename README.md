# Energía Vital

Tu pirámide de Estar Bien — control diario simple y visual de Energía Vital, Relaciones y Yo, más un planner de avances diarios.

## Vistas

- **Energía** — pirámide de 3 niveles que se llena día a día como un presupuesto: alimentación, sueño y ejercicio (base) + relaciones (medio) + yo (cima). Histórico de 14 días.
- **Avances diarios** — to-do list con categorías (Trabajo / Personal / Familia / Vida) e importancia (Vital / Importante / No imp.). Gráfico stacked de últimos 7 días.

## Características

- Multi-perfil con suscripción visual (Free / Pro)
- Login con sesión persistente
- Datos locales en `localStorage` — sobreviven cierres y recargas
- Respaldo automático a archivo (Chrome/Edge) — escribe `energia-vital-data.json` en una carpeta que tú eliges
- PWA instalable — funciona offline, se ve como app nativa en móvil
- Recordatorios programados (mañana 8:30 / noche 9:30)

## Stack

- HTML + CSS + JS vanilla, single-file (`index.html`)
- Service Worker para offline + manifest.json para install
- Servidor Node estático mínimo (sin dependencias) para deploy

## Ejecutar localmente

```bash
node server.js
# abre http://localhost:3000
```

## Deploy

Listo para Railway / Render / Vercel / cualquier hosting Node. El servidor lee `process.env.PORT`.

## Login demo

`victor@unabase.com` / `123456`

## Paleta

`#ffc0a5` `#c492a1` `#797084` `#7fa4c3` `#7edde4` `#c2ffdd`
