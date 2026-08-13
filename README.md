# SpiderKart

**SpiderKart** es un videojuego de autos desarrollado por **Spider-Web ARG** especialmente para el evento **Underc0de Day**, realizado en Mendoza, Argentina.

El juego está construido con tecnologías web: **HTML**, **CSS**, **JavaScript** y **Node.js**.

## Premios

Los **3 primeros puestos** en tiempo y puntaje obtendrán **1 mes gratis de Premium** en [Spider-Web ARG](https://spiderwebargapi.com.ar/), solo disponible durante el evento Underc0de Day el 12 de septiembre de 2026.

## Sobre el proyecto

SpiderKart fue creado especialmente para el evento **Underc0de Day** de Mendoza, donde los participantes podrán competir por el mejor tiempo y puntaje para ganar su lugar en el podio.

## Tecnologías utilizadas

- **HTML5**
- **CSS3**
- **JavaScript**
- **Node.js**

## Estructura del proyecto

```
SpiderKart/
├── public/          # Archivos estáticos del frontend (HTML, CSS, JS del juego)
├── init-db.js        # Inicialización de la base de datos
├── server.js          # Servidor Node.js
├── test-api.js        # Pruebas de la API
├── test-env.js         # Pruebas de variables de entorno
├── package.json        # Dependencias y scripts del proyecto
└── .gitignore
```

## Instalación y uso

1. Cloná el repositorio:
   ```bash
   git clone https://github.com/FrancoCalegari/SpiderKart.git
   cd SpiderKart
   ```

2. Instalá las dependencias:
   ```bash
   npm install
   ```

3. Configurá las variables de entorno necesarias (revisá `test-env.js` para ver cuáles usa el proyecto), por ejemplo creando un archivo `.env` en la raíz.

4. Inicializá la base de datos:
   ```bash
   node init-db.js
   ```

5. Iniciá el servidor:
   ```bash
   node server.js
   ```

6. Abrí tu navegador en `http://localhost:3000` (o el puerto configurado) y ¡a jugar! 🏁

# Créditos

Desarrollado por **[Spider-Web ARG](https://spiderwebargapi.com.ar/)** para el evento **Underc0de Day - Mendoza**.

## Licencia

Este proyecto fue creado con fines de evento/comunidad. Si querés usar o modificar el código, contactá al equipo de Spider-Web ARG.
**[GaboDev24](https://github.com/GaboDev24)**
**[Franco Calegari](https://github.com/FrancoCalegari)**