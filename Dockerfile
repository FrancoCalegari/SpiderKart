# Usa una imagen oficial de Node.js (Alpine es más ligera)
FROM node:22-alpine

# Crea y establece el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copia primero los archivos de dependencias para aprovechar la caché de Docker
COPY package*.json ./

# Instala las dependencias del proyecto (solo producción)
RUN npm ci --only=production

# Copia el resto del código del proyecto al contenedor
COPY . .

# Expone el puerto que usa el servidor (3000 por defecto)
EXPOSE 3000

# Define la variable de entorno de producción
ENV NODE_ENV=production

# Comando para iniciar la aplicación
CMD ["npm", "start"]
