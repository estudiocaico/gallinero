# Control de Gallinero

Aplicación personal y offline para registrar producción de huevos, consumo de alimento, agua, bajas, compras y sanidad del gallinero.

## Cómo usarla

Abrí `index.html` en el navegador, o iniciá el servidor local con:

```powershell
node dev-server.js
```

Después entrá a:

```text
http://127.0.0.1:4173
```

Los datos se guardan en el dispositivo desde donde se usa la app.

## Respaldo

- `Exportar Excel` genera una planilla `.csv` que Excel puede abrir.
- `Crear respaldo` genera un archivo `.json` completo.
- `Importar respaldo` restaura ese `.json` si cambiás de equipo o celular.
