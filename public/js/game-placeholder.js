document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('game-canvas-container');
    
    // Configuración básica de Three.js
    const scene = new THREE.Scene();
    
    // Cámara
    const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.z = 5;

    // Renderizador con antialiasing y fondo transparente
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Añadir luces
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0x6366f1, 2, 100);
    pointLight.position.set(2, 3, 4);
    scene.add(pointLight);

    const pointLight2 = new THREE.PointLight(0xec4899, 2, 100);
    pointLight2.position.set(-2, -3, 4);
    scene.add(pointLight2);

    // Crear un objeto (un cubo con rotación para simular algo en 3D)
    // En el futuro, aquí se cargaría el modelo del Kart
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    
    // Material tipo wireframe moderno
    const material = new THREE.MeshStandardMaterial({ 
        color: 0x1e293b,
        roughness: 0.2,
        metalness: 0.8,
        wireframe: true,
        emissive: 0x6366f1,
        emissiveIntensity: 0.2
    });
    
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);

    // Añadir partículas de fondo (estrellas/polvo)
    const particlesGeometry = new THREE.BufferGeometry();
    const particlesCount = 200;
    const posArray = new Float32Array(particlesCount * 3);

    for(let i = 0; i < particlesCount * 3; i++) {
        // Posiciones aleatorias entre -5 y 5
        posArray[i] = (Math.random() - 0.5) * 10;
    }

    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const particlesMaterial = new THREE.PointsMaterial({
        size: 0.05,
        color: 0xec4899,
        transparent: true,
        opacity: 0.8
    });

    const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particlesMesh);

    // Animación
    let clock = new THREE.Clock();

    function animate() {
        requestAnimationFrame(animate);

        const elapsedTime = clock.getElapsedTime();

        // Rotar objeto principal
        cube.rotation.x += 0.005;
        cube.rotation.y += 0.01;

        // Animar partículas suavemente
        particlesMesh.rotation.y = -elapsedTime * 0.1;
        particlesMesh.position.y = Math.sin(elapsedTime * 0.5) * 0.2;

        renderer.render(scene, camera);
    }

    // Manejar redimensionamiento
    window.addEventListener('resize', () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    });

    animate();
});
