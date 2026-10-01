# Mis Gastos — Control de finanzas

App web (instalable en el teléfono, funciona sin internet) para registrar los gastos de cada tarjeta y ver el total de cada ciclo de facturación.

## Qué hace

- **Registro rápido**: monto (en quetzales por defecto; toca la **Q** para cambiar a **$**), descripción, tarjeta y fecha (hoy por defecto).
  - Puedes escribir sumas en el monto, p. ej. `285+285`.
  - Las descripciones que ya usaste se autocompletan y sugieren la misma tarjeta.
- **Tarjetas**: Cuscatlán, BAC Credomatic, PriceSmart, BI Mastercard y BI Platinum.
- **Ciclos automáticos** según tu fecha de corte, sin tener que "cerrar" el mes:
  - Corte **22**: Cuscatlán, BI Mastercard, BI Platinum → ciclo 23 del mes anterior al 22.
  - Corte **24**: BAC Credomatic, PriceSmart → ciclo 25 del mes anterior al 24.
  - Pago **15** del mes siguiente al corte, para todas.
- **Detalle por tarjeta**: total del ciclo, lista de rubros, gráfica de los últimos 6 ciclos y navegación a ciclos anteriores.
- **Historial por mes de pago**: tabla con lo que pagaste/vas a pagar cada 15, por tarjeta.
- **Recordatorios**: cuando faltan 3 días o menos para un corte o para el pago, aparece un aviso discreto en la pantalla de nuevo gasto (con el total que llevas o el total a pagar).
- **Presupuesto opcional** por tarjeta para ver "Restante: Q__ de Q__".
- **Gastos en dólares**: se guardan en $ con el tipo de cambio del día (configurable en Ajustes) y se suman en quetzales.
- **Respaldo**: descarga/restaura un `.json` y exporta a CSV para Excel.

## Dónde se guardan los datos

En el almacenamiento local del navegador del teléfono (no se envían a ningún servidor). Si borras los datos del navegador se pierden, así que descarga un respaldo de vez en cuando desde **Ajustes**.

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
| `app.js` | Lógica: ciclos, totales, recordatorios, almacenamiento |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Instalación como app y uso sin conexión |
