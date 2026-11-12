# Galería

Galería es una aplicación web de fotos para el navegador, escrita con HTML, CSS y JavaScript puros. No necesita compilación ni dependencias, y se puede instalar como aplicación (PWA) para usarla sin conexión.

## Características

- Imágenes agrupadas por fecha.
- Álbumes (Cámara, Capturas de pantalla, Descargas, WhatsApp, etc.).
- Visor a pantalla completa con zoom.
- Editor básico: girar, recortar, voltear y ajustar.
- Favoritos.
- Papelera con restauración.
- Búsqueda.
- PWA: instalable y disponible sin conexión.

## Cómo ejecutarla

Como usa módulos ES, hay que servirla desde un servidor local (abrir el archivo directamente no funciona):

```bash
python3 -m http.server
```

Después abre [http://localhost:8000](http://localhost:8000) en el navegador.

## Estructura del proyecto

```
Prueba-Galeria/
├── icons/
│   └── icon.svg        # Icono de la aplicación
├── js/
│   ├── icons.js        # Iconos SVG en línea
│   └── samples.js      # Generador de fotos de ejemplo
├── manifest.webmanifest # Manifiesto de la PWA
├── sw.js               # Service worker (caché y modo sin conexión)
└── README.md
```
