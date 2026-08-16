# SpiderKart

SpiderKart es un videojuego de carreras de karts en tres dimensiones ejecutado directamente en el navegador web, desarrollado con Three.js, JavaScript moderno, Node.js, Express y WebSockets.

El proyecto fue creado por el equipo de Spider-Web ARG como demostracion tecnica y atraccion competitiva para el evento tecnologico Underc0de Day en Mendoza, Argentina.

---

## Tabla de Contenidos

- [Descripcion General](#descripcion-general)
- [Caracteristicas Principales](#caracteristicas-principales)
- [Arquitectura del Sistema](#arquitectura-del-sistema)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Mecanicas del Videojuego](#mecanicas-del-videojuego)
- [Controles](#controles)
- [Protocolo Multijugador (WebSockets)](#protocolo-multijugador-websockets)
- [API REST y Base de Datos](#api-rest-y-base-de-datos)
- [Requisitos del Sistema](#requisitos-del-sistema)
- [Instalacion y Configuracion](#instalacion-y-configuracion)
- [Ejecucion](#ejecucion)
- [Creditos y Licencia](#creditos-y-licencia)

---

## Descripcion General

SpiderKart combina un portal web con estetica tactica y una arena de carreras 3D de alto rendimiento acelerada por WebGL. Permite a los corredores registrarse, iniciar sesion, disputar carreras individuales o multijugador en tiempo real, cronometrar sus tiempos por vuelta y competir por los primeros puestos en una tabla de clasificacion global.

---

## Caracteristicas Principales

- Motor Grafico 3D en Tiempo Real: Renderizado en el navegador basado en Three.js con iluminacion dinamica direccional y puntual, sombras suaves (PCFSoftShadowMap), niebla volumetrica y escenarios con relieve procedural.
- Motor de Fisica y Conduccion: Modelo de aceleracion lineal y angular, friccion dependiente de la superficie, marcha atras, giro de ruedas direccionales, suspension simulada y balanceo de camara.
- Sistema de Derrape (Drift): Mecanica de derrape activo al doblar junto con la barra espaciadora, permitiendo cargar mini-turbos al salir de las curvas junto a efectos de chispas y estelas.
- Deteccion de Sentido Contrario (Anti-Cheat): Calculo vectorial mediante producto escalar (dot product) contra la tangente del trazado del circuito. Bloquea el registro de checkpoints fraudulentos y notifica al piloto en pantalla.
- Sistema de Cronometraje de Precision: Calculo de tiempo total de carrera, parciales de cada vuelta y deteccion del record de mejor vuelta personal (Best Lap).
- HUD Tactico en Pantalla: Indicadores de velocidad digital, barra de nitro/turbo interactiva, slots de misiles e inventario, cuenta regresiva animada, cartel de vuelta actual y minimapa 2D renderizado en Canvas vectorial.
- Multijugador en Vivo por Salas: Servidor WebSocket integrado que permite el emparejamiento de jugadores, transmision de telemetria en tiempo real a alta frecuencia y sincronizacion de posiciones.
- Sistema de Items y Combate: Recoleccion de potenciadores en pista, misiles guiados y rectos con deteccion de impacto sobre rivales.
- Autenticacion Segura: Modales de registro e inicio de sesion con cifrado de contraseñas mediante bcrypt.
- Tabla de Clasificacion (Leaderboard): Persistencia de records y ranking en tiempo real conectado a base de datos relacional via API de SpiderWebARG.

---

## Arquitectura del Sistema

El sistema esta estructurado en dos capas principales:

1. Capa de Servidor (Backend):
   - Servidor HTTP con Express para la distribucion de los assets estaticos del cliente.
   - Servidor WebSocket (ws) corriendo sobre la misma instancia HTTP para la gestion de salas y sincronizacion de carrera.
   - Adaptador de consultas SQL hacia la API REST de persistencia de SpiderWebARG.
   - Capa de autenticacion con hash de credenciales via bcrypt.

2. Capa de Cliente (Frontend):
   - Portal Web (index.html, main.js, tactical.css, index.css): Panel de mando con estilo tactico/HUD, gestion de sesion con localStorage y tabla de clasificacion con recarga asincrona.
   - Arena de Juego (game.html, game-engine.js, multiplayer.js): Renderizador Three.js, generador de geometrias de circuito Catmull-Rom 3D, simulacion fisica del kart, bucle de renderizado a 60 FPS, procesamiento de inputs y cliente WebSocket.

---

## Estructura del Proyecto

```
SpiderKart/
|-- public/                      # Archivos estaticos y cliente web
|   |-- css/
|   |   |-- index.css            # Estilos del portal principal
|   |   `-- tactical.css         # Componentes y variables de diseño tactico
|   |-- js/
|   |   |-- game-engine.js       # Motor principal del juego 3D (Three.js, fisicas, pista)
|   |   |-- multiplayer.js       # Cliente WebSocket para salas y sincronizacion remota
|   |   |-- main.js              # Logica del portal (Auth, Leaderboard, Modales)
|   |   |-- theme.js             # Gestor de temas de interfaz
|   |   `-- game-placeholder.js  # Modulo auxiliar de compatibilidad
|   |-- game.html                # Interfaz y canvas de la arena de carreras 3D
|   `-- index.html               # Portal principal de bienvenida y ranking
|-- init-db.js                   # Script de creacion inicial de tablas en la base de datos
|-- server.js                    # Servidor Express, API REST y servidor WebSocket
|-- test-api.js                  # Script de prueba para validar la API de SpiderWebARG
|-- test-env.js                  # Verificador de configuracion de variables de entorno
|-- package.json                 # Definicion de dependencias y scripts de ejecucion
|-- .env                         # Variables de entorno y credenciales (local)
`-- README.md                    # Documentacion del repositorio
```

---

## Mecanicas del Videojuego

### Circuito y Checkpoints
El trazado de la pista esta definido por una curva tridimensional suave de tipo CatmullRomCurve3 con puntos de control precalculados. La pista incluye:
- Calzada de asfalto oscuro con bordes y linea central luminosa.
- Barreras de contencion laterales que delimitan el area transitable.
- Serie de checkpoints invisibles a lo largo del circuito que deben atravesarse en orden para validar cada vuelta reglamentaria.
- Decoracion perimetral procedural con formaciones montañosas y torres de iluminacion.

### Sistema de Conduccion y Fisicas
- Aceleracion y Freno: Curva exponencial de velocidad dependiente de la inercia y resistencia al avance.
- Direccion Dinamica: Las ruedas delanteras responden visualmente al angulo de giro mientras el chasis experimenta inclinacion lateral (body roll).
- Salto y Suspension: Impulso vertical controlado para superar obstaculos menores o preparar maniobras de derrape.

### Derrape y Mini-Turbo
Al doblar mientras se sostiene la tecla de salto (Espacio), el kart entra en modo de derrape:
- Se reduce la friccion lateral permitiendo que el vehiculo mantenga una trayectoria angular cerrada.
- Se generan particulas y chispas bajo los neumaticos traseros.
- Al soltar el derrape tras un tiempo minimo, se otorga una bonificacion temporal de velocidad punta (Mini-Turbo).

### Potenciadores y Combate
- Turbo Manual (Tecla K): Impulso temporal que aumenta la velocidad maxima y distorsiona el campo de vision de la camara (FOV). Cuenta con tiempo de recarga visible en el HUD.
- Misiles (Tecla E): Lanzamiento de proyectiles rectos o teledirigidos capaces de impactar e interrumpir la trayectoria de otros karts.

---

## Controles

| Accion | Teclas Alternativas | Descripcion |
| --- | --- | --- |
| Acelerar | W / Flecha Arriba | Incrementa la velocidad hacia adelante |
| Frenar / Reversa | S / Flecha Abajo | Reduce la velocidad o retrocede si el vehiculo esta detenido |
| Girar Izquierda | A / Flecha Izquierda | Vira las ruedas y orienta el kart a la izquierda |
| Girar Derecha | D / Flecha Derecha | Vira las ruedas y orienta el kart a la derecha |
| Salto / Derrape | Barra Espaciadora | Salto corto; derrape activo si se mantiene pulsado durante un giro |
| Disparar Misil | E | Dispara un proyectil del inventario activo |
| Turbo | K | Activa la aceleracion especial cuando la barra este cargada |

---

## Protocolo Multijugador (WebSockets)

La comunicacion multijugador opera en tiempo real bajo formato JSON a traves de WebSockets.

### Eventos Cliente hacia Servidor

- `join`: Solicitud para unirse a una sala (`room`, `name`, `pilotId`).
- `ready`: Notificacion de estado listo para comenzar.
- `state`: Envio periodico de telemetria del kart (`x`, `y`, `z`, `angle`, `speed`, `boosting`, `lap`).
- `hit`: Reporte de impacto de un proyectil sobre otro corredor (`targetId`).
- `finish`: Notificacion de carrera completada (`timeMs`, `lap`).
- `leave`: Abandono de la sala actual.

### Eventos Servidor hacia Cliente

- `joined`: Confirmacion de ingreso con listado de corredores presentes.
- `player_joined`: Anuncio de un nuevo competidor en la sala.
- `player_left`: Notificacion de desconexion de un competidor.
- `waiting`: Notificacion de estado de espera de competidores minimos.
- `countdown`: Notificacion del conteo regresivo previo a la largada.
- `race_start`: Inicio sincronizado de la carrera.
- `state`: Difusion de la posicion y estado de karts remotos.
- `hit`: Confirmacion de colision/impacto a los clientes afectados.
- `race_results`: Tabla final de posiciones y tiempos al culminar la carrera.
- `error`: Mensaje informativo en caso de sala llena o partida en progreso.

---

## API REST y Base de Datos

El backend expone las siguientes rutas HTTP:

| Metodo | Endpoint | Descripcion | Cuerpo de la Solicitud (JSON) |
| --- | --- | --- | --- |
| GET | `/api/init-db` | Crea las tablas necesarias en la base de datos si no existen | N/A |
| POST | `/api/auth/register` | Registra una nueva cuenta de piloto | `{ "username": "...", "password": "..." }` |
| POST | `/api/auth/login` | Autentica un usuario y devuelve su identificador | `{ "username": "...", "password": "..." }` |
| GET | `/api/leaderboard` | Obtiene el top 10 de mejores puntuaciones | N/A |
| POST | `/api/leaderboard` | Registra una nueva puntuacion | `{ "userId": 1, "score": 1500 }` |

### Esquema de Tablas

#### Tabla `users`
- `id`: INT AUTO_INCREMENT PRIMARY KEY
- `username`: VARCHAR(50) UNIQUE NOT NULL
- `password_hash`: VARCHAR(255) NOT NULL
- `created_at`: TIMESTAMP DEFAULT CURRENT_TIMESTAMP

#### Tabla `leaderboard`
- `id`: INT AUTO_INCREMENT PRIMARY KEY
- `user_id`: INT (Clave foranea referenciando a `users.id`)
- `score`: INT NOT NULL
- `recorded_at`: TIMESTAMP DEFAULT CURRENT_TIMESTAMP

---

## Requisitos del Sistema

- Node.js version 18.0.0 o superior.
- Navegador web moderno con soporte completo para WebGL y WebSockets (Chrome, Firefox, Edge, Safari).
- Conectividad a internet para resolucion de CDNs de Three.js y tipografias de Google Fonts.

---

## Instalacion y Configuracion

1. Clonar el repositorio:
   ```bash
   git clone https://github.com/FrancoCalegari/SpiderKart.git
   cd SpiderKart
   ```

2. Instalar dependencias del proyecto:
   ```bash
   npm install
   ```

3. Configurar variables de entorno:
   Crear un archivo `.env` en la raiz del proyecto con las siguientes variables:
   ```env
   PORT=3000
   spiderapikey=TU_API_KEY_DE_SPIDERWEB
   spiderdbname=TU_NOMBRE_DE_BASE_DE_DATOS
   ```

4. Inicializar tablas de la base de datos:
   ```bash
   node init-db.js
   ```

---

## Ejecucion

### Modo Produccion
```bash
npm start
```

### Modo Desarrollo (con recarga automatica)
```bash
npm run dev
```

Una vez iniciado el servidor, acceder desde el navegador a:
```
http://localhost:3000
```

---

## Premios y Evento

Los 3 primeros puestos en tiempo y puntaje obtendran 1 mes gratis de suscripcion Premium en la plataforma Spider-Web ARG, disponible durante el evento Underc0de Day en Mendoza.

---

## Creditos y Licencia

Desarrollado por el equipo de Spider-Web ARG:
- Franco Calegari (https://github.com/FrancoCalegari)
- GaboDev24 (https://github.com/GaboDev24)

Proyecto desarrollado para la comunidad y eventos tecnologicos. Para usos comerciales o adaptaciones, contactar directamente a los autores.