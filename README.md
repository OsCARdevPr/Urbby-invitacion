# Invitaciones Urbby

App para las invitaciones del prelaunch de Urbby:

1. Importas la lista de invitados desde Excel.
2. La app genera una **tarjeta de invitación** (PNG 1080×1350) por persona, con su nombre, su negocio y un **QR único**.
3. La envía por **correo** (Resend) y por **WhatsApp** (Evolution API), a un ritmo lento para cuidar el número.
4. En la puerta, el portero **escanea el QR** con el celular y la app marca el ingreso.

Stack: Node 22 + Hono (API), React + Vite + Tailwind (panel), **Postgres** (datos), satori + resvg (tarjetas).
Todo corre en **Docker**: un contenedor con la base de datos y otro con la app (la API y el panel web salen del mismo servidor).

---

## Cómo se usa (el flujo completo)

1. **Crea el evento** en *Eventos → Nuevo evento*. Lleva nombre, fecha, hora, lugar y el mensaje de WhatsApp. La tarjeta y el
   mensaje se previsualizan en vivo.
2. **Importa la lista** (Excel `.xlsx` o CSV) desde el detalle del evento → *Importar lista*. Tiene que traer los encabezados
   `Nombre`, `Negocio`, `Teléfono` y `Correo`, en cualquiera de las primeras 10 filas; otras columnas se ignoran. Hay un
   ejemplo del formato en [`ejemplos/invitados-ejemplo.csv`](ejemplos/invitados-ejemplo.csv).
   - Los nombres escritos TODO EN MAYÚSCULAS o todo en minúsculas se ordenan ("GENESIS DE CARCAMO" → "Genesis de Carcamo").
   - Antes de guardar ves una vista previa con las filas listas, con aviso, repetidas o con error.
   - Los teléfonos de 8 dígitos se asumen de El Salvador (+503).
3. **Descarga los contactos (.vcf)** e impórtalos en el teléfono del número secundario (ver abajo).
4. **Envía los correos.** Salen a todos de una vez y le piden al invitado que guarde el número de WhatsApp.
5. **Encola por WhatsApp** y ve a *WhatsApp → Empezar*. La campaña envía de a uno, con pausas al azar, solo en horario y hasta
   el tope diario.
6. **Día del evento.** Cada portero entra con **su nombre** y la contraseña de portero (no hay cuentas que crear) y va directo
   al escáner. Cada ingreso queda guardado con quién lo registró: el escáner muestra cuántos lleva cada uno, y el panel, el
   total por portero. Resultados:
   - 🟢 **Bienvenido/a:** ingreso registrado.
   - 🟡 **Ya ingresó:** verificar que sea la misma persona.
   - 🔴 **QR no válido o de otro evento.**

   Si un QR no se lee, se puede **buscar por nombre** y marcar el ingreso a mano.

---

## WhatsApp sin que bloqueen el número

Ningún ajuste garantiza que WhatsApp no bloquee un número usado con Evolution API (no es la API oficial). Lo que más pesa es
que la gente **no reporte ni bloquee** el mensaje. La app hace lo que está a su alcance:

| Medida | Valor por defecto |
|---|---|
| Tope diario (suma de todos los eventos) | 20 mensajes |
| Pausa entre mensajes | 3 a 7 min, al azar |
| Pausa larga | 15 a 30 min cada 5 a 8 envíos |
| "Escribiendo…" antes de cada mensaje | 4 a 9 s |
| Horario | 09:00 a 19:00 (hora de El Salvador), arranque con 0 a 15 min al azar |
| Si WhatsApp se desconecta | la campaña se pausa sola |
| 3 errores seguidos | la campaña se pausa sola |
| Reinicio a mitad de un envío | queda como **Revisar**; nunca se reenvía solo |
| Verificación de números en lote | **no se hace**: hay reportes de restricciones por usarla |

Lo que te toca a ti:

- **Usa un número secundario**, nunca el +503 7563 4349 (el registrado en Meta).
- **Caliéntalo**: úsalo a mano unos días antes, con chats reales y respuestas.
- **Importa el .vcf** en ese teléfono antes de empezar la campaña.
- **Manda primero los correos**: piden guardar tu número, y que el invitado lo tenga guardado es la mejor protección.
- **Responde a quien conteste.** Las conversaciones de ida y vuelta protegen el número.
- **No subas el tope de golpe.** Si ves errores o bloqueos, pausa un día.
- **No pongas enlaces** en el mensaje de WhatsApp. El panel avisa si hay uno.

### Importar el .vcf en el teléfono

- **Android:** abre el archivo desde Descargas o Drive → *Contactos* → Importar. O en contacts.google.com → *Importar*, con la
  misma cuenta de Google del teléfono.
- **iPhone:** envíatelo por correo y ábrelo → *Añadir todos los contactos*. O en icloud.com/contacts → ⚙︎ → *Importar vCard*.

Luego abre WhatsApp y espera a que se sincronicen los contactos.

---

## Levantar todo con Docker

Necesitas Docker Desktop encendido. La primera vez, crea el `.env` a partir de la plantilla y ajusta las contraseñas (si ya
tienes un `.env`, no lo copies encima: perderías tus claves):

```bash
cp .env.example .env
```

Luego levanta la base de datos y la app:

```bash
docker compose up -d --build
```

Entra a **http://localhost:3000**.

| Comando | Qué hace |
|---|---|
| `docker compose logs -f app` | Ver lo que pasa en la app |
| `docker compose restart app` | Reiniciar la app (por ejemplo, después de cambiar el `.env`) |
| `docker compose up -d --build` | Reconstruir después de cambiar el código |
| `docker compose down` | Apagar todo. **Los datos se conservan** en el volumen `pgdata` |

Los datos (eventos, invitados, ingresos y ajustes) viven en **Postgres**. El contenedor de la app no guarda nada importante.

### Desarrollo con recarga automática (opcional)

Con la base de Docker encendida (`docker compose up -d db`), puedes correr la app fuera de Docker con `npm install` y luego
`npm run dev`: la API queda en :3000 y el panel en http://localhost:5173. Las pruebas de la lógica se corren con `npm test`.

La cámara del escáner **necesita HTTPS**. Para probarla desde un celular usa la app desplegada, o un túnel HTTPS hacia
`http://localhost:3000`.

---

## Despliegue en Dokploy

1. El código vive en **https://github.com/OsCARdevPr/Urbby-invitacion** (rama `main`). No subas nunca la lista real de
   invitados ni el `.env`: tienen datos personales y claves (el `.gitignore` ya los excluye).
2. En Dokploy crea un servicio **Compose**:
   - *Source:* el repositorio de GitHub, rama `main`.
   - *Compose path:* `docker-compose.yml`.
3. En *Environment* pega las variables de `.env.example` con los valores reales. Como mínimo:
   - Acceso: `ADMIN_PASSWORD`, `DOORMAN_PASSWORD`, `SESSION_SECRET`.
   - Base de datos: `POSTGRES_PASSWORD` (una clave larga). `DATABASE_URL` la arma el compose solo.
   - URL pública: `PUBLIC_BASE_URL=https://invitaciones.urbby.app`.
   - Evolution: `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `WEBHOOK_SECRET`, `SENDER_PHONE_DISPLAY`.
   - Resend: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`.

   Define `POSTGRES_PASSWORD` **antes del primer deploy**: Postgres la fija al crear la base y después no la cambia.
4. En *Domains*:
   - Agrega `invitaciones.urbby.app` → servicio **app**, puerto **3000**, con HTTPS (Let's Encrypt).
   - En el DNS de urbby.app crea un registro **A** `invitaciones` → IP del VPS.
5. **Deploy.** Luego entra al panel → *WhatsApp* → **Configurar en Evolution**, que apunta el webhook de la instancia a la
   app para recibir los estados de entrega y lectura. Hazlo **después** de tener el dominio con HTTPS.

Los datos quedan en el volumen de Postgres del compose y sobreviven a cada deploy.

> Mientras `PUBLIC_BASE_URL` apunte a `localhost` (desarrollo), los envíos masivos de correo y WhatsApp están bloqueados:
> esas invitaciones no servirían en la puerta. Sí se puede enviar a un invitado puntual desde su ficha, para probar.

> ⚠️ `PUBLIC_BASE_URL` es la URL que va dentro de cada QR. Defínela bien **antes** de enviar invitaciones: si la cambias
> después, los QR ya enviados apuntarán a la URL vieja. Aun así se podrán escanear, porque el escáner solo lee el código
> del final.

### Resend (correo)

1. Crea la cuenta en resend.com → *Domains* → *Add domain* → `urbby.app`.
2. Agrega en el DNS los registros que te muestra (MX, TXT de SPF y DKIM) y espera a que el dominio quede *Verified*.
3. Crea una API key con permiso *Sending* y ponla en `RESEND_API_KEY`.

El plan gratis alcanza de sobra: 100 correos al día y 3 000 al mes.

---

## Estructura

```
assets/                 logo, trazos y fuentes de la tarjeta
src/shared/             tipos y plantillas compartidos por servidor y panel
src/server/
  index.ts              servidor Hono: API, webhook, página pública /i/:token, panel
  db.ts                 Postgres + migraciones
  auth.ts               login admin / portero (cookie firmada)
  routes/               events, guests, checkin, wa, public
  services/             card (tarjeta), excel, phone, email, evolution, webhook, vcf, qr
  worker/               cola de WhatsApp (whatsappQueue + pacing) y envío de correos
src/web/                panel React: eventos, detalle, campaña de WhatsApp, escáner
tests/                  pruebas de la lógica pura
```
