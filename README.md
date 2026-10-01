# Mis Gastos — Control de finanzas

App web (instalable en el teléfono, funciona sin internet) para registrar los gastos de cada tarjeta y ver el total de cada ciclo de facturación.

## Qué hace

- **Registro rápido**: monto (en quetzales por defecto; toca la **Q** para cambiar a **$**), descripción, tarjeta y fecha (hoy por defecto).
  - Puedes escribir sumas en el monto, p. ej. `285+285`.
  - Las descripciones que ya usaste se autocompletan y sugieren la misma tarjeta.
- **Tarjetas editables** (Ajustes → Mis tarjetas): agrega, edita o elimina tarjetas; cada una con su nombre, color, día de corte, día de pago y presupuesto opcional. Vienen precargadas Cuscatlán, BAC Credomatic, PriceSmart, BI Mastercard y BI Platinum.
- **Ciclos automáticos** según la fecha de corte de cada tarjeta, sin tener que "cerrar" el mes. Por ejemplo, con corte **22** y pago **15**: el ciclo va del 23 de un mes al 22 del siguiente y se paga el 15 del mes después. El pago es siempre la primera fecha con ese día después del corte.
- **Detalle por tarjeta**: total del ciclo, lista de rubros, gráfica de los últimos 6 ciclos y navegación a ciclos anteriores.
- **Historial por mes de pago**: tabla con lo que pagaste/vas a pagar cada mes, por tarjeta.
- **Recordatorios por tarjeta**: cuando faltan 3 días o menos para el corte o el pago de una tarjeta, aparece un aviso discreto en la pantalla de nuevo gasto (con lo que llevas en el ciclo o el total a pagar).
- **Presupuesto opcional** por tarjeta para ver "Restante: Q__ de Q__".
- **Gastos en dólares**: se guardan en $ con el tipo de cambio del día (configurable en Ajustes) y se suman en quetzales.
- **Respaldo**: descarga/restaura un `.json` y exporta a CSV para Excel.

## Dónde se guardan los datos

- **Sin sesión**: solo en el teléfono (almacenamiento local del navegador).
- **Con sesión de Google** (Ajustes → Iniciar sesión con Google): además se guardan en Firebase (Firestore), así que puedes cambiar de teléfono o usar la computadora y ver todo tu historial.
  - La primera vez que inicias sesión en un teléfono, los gastos que ya había ahí se suben a tu cuenta (no se borra nada de la nube).
  - Funciona sin internet: los cambios se guardan en el teléfono y se suben al reconectar.
  - Al cerrar sesión, los datos se ocultan de ese teléfono pero siguen en tu cuenta.
- Desde **Ajustes** también puedes descargar un respaldo `.json` o exportar a CSV.

### Firebase

Proyecto `mis-gastos-f3098`. La configuración está en `sync.js` (no es secreta). Estructura:

```
users/{uid}                    → { settings: { rate, cards }, updatedAt }
users/{uid}/expenses/{gastoId} → gasto
```

Reglas de Firestore (cada usuario solo puede leer y escribir lo suyo):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

En Authentication → Configuración → Dominios autorizados debe estar `fjgalicia-art.github.io`.

## Cómo usarla en el teléfono

1. En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, rama `main`, carpeta `/ (root)`.
2. Abre la URL que te da GitHub Pages (algo como `https://<usuario>.github.io/App-Control-de-finanzas/`) en Chrome.
3. Menú ⋮ → **Agregar a la pantalla principal / Instalar app**.

Para probarla en la computadora basta con abrir `index.html`, o servir la carpeta con `python3 -m http.server`.

## Archivos

| Archivo | Descripción |
| --- | --- |
| `index.html` | Estructura de las pantallas |
| `styles.css` | Estilos (modo claro/oscuro) |
| `app.js` | Lógica: ciclos, totales, recordatorios, almacenamiento local |
| `sync.js` | Inicio de sesión con Google y sincronización con Firebase |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Instalación como app y uso sin conexión |
