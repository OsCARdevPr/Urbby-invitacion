# Invitaciones Urbby

App para las invitaciones del prelaunch de Urbby:

1. Importas la lista de invitados desde Excel.
2. La app genera una **tarjeta de invitación** (PNG 1080×1350) por persona, con su nombre, su negocio y un **QR único**.
3. La envía por **correo** (Resend) y por **WhatsApp** (Evolution API), a un ritmo lento para cuidar el número.
4. En la puerta, el portero **escanea el QR** con el celular y la app marca el ingreso.

Stack: Node 22 + Hono + SQLite (servidor), React + Vite + Tailwind (panel), satori + resvg (tarjetas).
Todo corre en **un solo contenedor**.

---

## Cómo se usa (el flujo completo)

1. **Crea el evento** en *Eventos → Nuevo evento*. Lleva nombre, fecha, hora, lugar y el mensaje de WhatsApp. La tarjeta y el
   mensaje se previsualizan en vivo.
2. **Importa el Excel.** Tiene que traer los encabezados `Nombre`, `Negocio`, `Teléfono` y `Correo`, pero pueden estar en
   cualquier fila de las primeras 10.
   - Antes de guardar ves una vista previa con las filas listas, con aviso, repetidas o con error.
   - Los teléfonos de 8 dígitos se asumen de El Salvador (+503).
3. **Descarga los contactos (.vcf)** e impórtalos en el teléfono del número secundario (ver abajo).
4. **Envía los correos.** Salen a todos de una vez y le piden al invitado que guarde el número de WhatsApp.
5. **Encola por WhatsApp** y ve a *WhatsApp → Empezar*. La campaña envía de a uno, con pausas al azar, solo en horario y hasta
   el tope diario.
6. **Día del evento.** El portero entra con su contraseña, que lo lleva directo al escáner. Resultados:
   - 🟢 **Bienvenido/a:** ingreso registrado.
   - 🟡 **Ya ingresó:** verificar que sea la misma persona.
   - 🔴 **QR no válido o de otro evento.**

   Si un QR no se lee, se puede **buscar por nombre** y marcar el ingreso a mano.

Quien responda **CONFIRMO** por WhatsApp queda marcado como confirmado (requiere el webhook, ver abajo).

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

## Desarrollo local

```bash
npm install
cp .env.example .env      # en desarrollo puedes dejar las contraseñas vacías: admin / portero
npm run dev               # panel en http://localhost:5173 · API en :3000
npm test                  # pruebas de la lógica (teléfonos, Excel, ritmo, webhook…)
```

La cámara del escáner **necesita HTTPS**. Para probarla desde un celular usa la app desplegada, o un túnel HTTPS como
`cloudflared tunnel --url http://localhost:5173`.

---

## Despliegue en Dokploy

1. **Sube el proyecto a GitHub** (repositorio privado):
   ```bash
   git init && git add . && git commit -m "Invitaciones Urbby"
   git remote add origin git@github.com:<tu-usuario>/urbby-invitaciones.git
   git push -u origin main
   ```
2. En Dokploy crea una **Application**:
   - *Source:* el repositorio de GitHub, rama `main`.
   - *Build type:* **Dockerfile**.
3. En *Environment* define las variables (ver `.env.example`). Como mínimo:
   - Acceso: `ADMIN_PASSWORD`, `DOORMAN_PASSWORD`, `SESSION_SECRET`.
   - URL pública: `PUBLIC_BASE_URL=https://invitaciones.urbby.app`.
   - Evolution: `EVOLUTION_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `WEBHOOK_SECRET`, `SENDER_PHONE_DISPLAY`.
   - Resend: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`.

   Si Evolution corre en el mismo Dokploy, en `EVOLUTION_URL` puedes usar el nombre interno del servicio, por ejemplo
   `http://evolution-api:8080`.
4. En *Advanced → Volumes / Mounts* agrega un **Volume Mount** en `/app/data`. Ahí viven la base de datos y las tarjetas; sin el
   volumen se pierden en cada deploy. Usa un *Volume Mount* y no un *Bind Mount*: la app corre como el usuario `node`, y una
   carpeta del host montada con bind suele quedar de root y sin permiso de escritura.
5. En *Domains*:
   - Agrega `invitaciones.urbby.app`, puerto **3000**, con HTTPS (Let's Encrypt).
   - En el DNS de urbby.app crea un registro **A** `invitaciones` → IP del VPS.
6. **Deploy.** Luego entra al panel → *WhatsApp* → **Configurar en Evolution**, que apunta el webhook de la instancia a la
   app. Hazlo **después** de tener el dominio con HTTPS.

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
  db.ts                 SQLite + migraciones
  auth.ts               login admin / portero (cookie firmada)
  routes/               events, guests, checkin, wa, public
  services/             card (tarjeta), excel, phone, email, evolution, webhook, vcf, qr
  worker/               cola de WhatsApp (whatsappQueue + pacing) y envío de correos
src/web/                panel React: eventos, detalle, campaña de WhatsApp, escáner
tests/                  pruebas de la lógica pura
```
