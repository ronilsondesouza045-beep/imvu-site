(() => {
  "use strict";

  let ctx = null;

  const emptyDebug = () => ({ ready: false });

  function disposeMaterial(material) {
    if (!material) return;
    const maps = [material.map, material.alphaMap, material.emissiveMap, material.normalMap];
    for (const map of maps) {
      try {
        map?.dispose?.();
      } catch {
        /* ignora */
      }
    }
    try {
      material.dispose?.();
    } catch {
      /* ignora */
    }
  }

  function disposeScene(scene) {
    scene?.traverse((object) => {
      try {
        object.geometry?.dispose?.();
      } catch {
        /* ignora */
      }
      if (Array.isArray(object.material)) {
        for (const material of object.material) disposeMaterial(material);
      } else {
        disposeMaterial(object.material);
      }
    });
  }

  function makeInitialsTexture(THREE, occupant) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#2b1e54");
    gradient.addColorStop(1, "#0b0d18");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#c4b5fd";
    context.font = "bold 96px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const raw = String(occupant.displayName || occupant.username || "?")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .slice(0, 2)
      .toUpperCase();
    context.fillText(raw || "?", canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  function start(container, room, options = {}) {
    stop();
    if (!container) return;
    const THREE = window.THREE;
    if (!THREE) {
      options.onError?.("Three.js não carregou.");
      return;
    }

    try {
      const imageUrl = typeof options.imageUrl === "function" ? options.imageUrl : (url) => url;
      let pending = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        options.onReady?.();
      };
      const task = () => {
        pending += 1;
      };
      const done = () => {
        pending = Math.max(0, pending - 1);
        if (pending === 0) finish();
      };
      const timer = setTimeout(finish, 20_000);

      const holder = document.createElement("div");
      holder.className = "cinema-3d-canvas";
      container.appendChild(holder);

      const width = Math.max(320, container.clientWidth || 900);
      const height = Math.max(240, container.clientHeight || 520);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05070c);
      scene.fog = new THREE.Fog(0x05070c, 70, 170);

      const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 500);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(width, height);
      renderer.outputEncoding = THREE.sRGBEncoding;
      holder.appendChild(renderer.domElement);

      const bounds = room.bounds || { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
      const centerX = (Number(bounds.minX) + Number(bounds.maxX)) / 2;
      const centerZ = (Number(bounds.minZ) + Number(bounds.maxZ)) / 2;
      const roomWidth = Math.max(18, Number(bounds.maxX) - Number(bounds.minX) + 14);
      const roomDepth = Math.max(18, Number(bounds.maxZ) - Number(bounds.minZ) + 14);
      const backdropZ = Number(bounds.minZ) - 3;

      camera.position.set(centerX, 15, Number(bounds.maxZ) + 22);
      camera.lookAt(centerX, 2, centerZ);

      const hemisphere = new THREE.HemisphereLight(0xa7c0ff, 0x080812, 0.95);
      scene.add(hemisphere);
      const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
      keyLight.position.set(12, 24, 12);
      scene.add(keyLight);
      const purple = new THREE.PointLight(0x7c5cff, 0.8, 80);
      purple.position.set(centerX - 8, 8, centerZ - 6);
      scene.add(purple);

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(roomWidth, roomDepth),
        new THREE.MeshStandardMaterial({ color: 0x0c1020, roughness: 0.92, metalness: 0.05 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(centerX, 0, centerZ);
      scene.add(floor);

      const grid = new THREE.GridHelper(
        Math.max(roomWidth, roomDepth),
        26,
        0x4c3a8a,
        0x1a1f35
      );
      grid.position.set(centerX, 0.02, centerZ);
      scene.add(grid);

      const backdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(roomWidth, 18),
        new THREE.MeshStandardMaterial({ color: 0x151829, roughness: 1 })
      );
      backdrop.position.set(centerX, 8.5, backdropZ);
      scene.add(backdrop);
      const preview = room.renderedImage || room.previewImage || "";
      if (preview) {
        task();
        new THREE.TextureLoader().load(
          imageUrl(preview),
          (texture) => {
            texture.encoding = THREE.sRGBEncoding;
            backdrop.material.map = texture;
            backdrop.material.color.set(0xffffff);
            backdrop.material.needsUpdate = true;
            done();
          },
          undefined,
          done
        );
      }

      const assets = Array.isArray(room.assets) ? room.assets : [];
      for (const asset of assets) {
        const scale = Math.max(0.4, Number(asset.scale) || 1);
        const geometry = new THREE.BoxGeometry(1.8 * scale, 1.6 * scale, 1.8 * scale);
        const material = new THREE.MeshStandardMaterial({
          color: 0x6b7280,
          roughness: 0.8,
          metalness: 0.06,
        });
        const box = new THREE.Mesh(geometry, material);
        const [x, y, z] = Array.isArray(asset.position) ? asset.position : [0, 0, 0];
        const [pitch, yaw, roll] = Array.isArray(asset.rotation) ? asset.rotation : [0, 0, 0];
        box.position.set(Number(x) || 0, (Number(y) || 0) + 0.8 * scale, Number(z) || 0);
        box.rotation.order = "YXZ";
        box.rotation.set(Number(pitch) || 0, Number(yaw) || 0, Number(roll) || 0);
        box.userData = { name: String(asset.name || "Móvel"), asset };
        scene.add(box);

        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry),
          new THREE.LineBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.35 })
        );
        edges.position.copy(box.position);
        edges.rotation.copy(box.rotation);
        scene.add(edges);

        if (asset.image) {
          task();
          new THREE.TextureLoader().load(
            imageUrl(asset.image),
            (texture) => {
              texture.encoding = THREE.sRGBEncoding;
              material.map = texture;
              material.color.set(0xffffff);
              material.needsUpdate = true;
              done();
            },
            undefined,
            done
          );
        }

        if (asset.modelUrl) {
          task();
          const onModel = (object) => {
            object.position.copy(box.position);
            object.rotation.copy(box.rotation);
            object.scale.multiplyScalar(scale);
            scene.add(object);
            scene.remove(box);
            scene.remove(edges);
            done();
          };
          const onModelError = () => done();
          try {
            if (asset.type === "obj" && THREE.OBJLoader) {
              new THREE.OBJLoader().load(asset.modelUrl, onModel, undefined, onModelError);
            } else if (THREE.GLTFLoader) {
              new THREE.GLTFLoader().load(
                asset.modelUrl,
                (gltf) => onModel(gltf.scene),
                undefined,
                onModelError
              );
            } else {
              done();
            }
          } catch {
            done();
          }
        }
      }

      const occupants = Array.isArray(room.occupants) ? room.occupants : [];
      const avatarZ = Number(bounds.maxZ) + 4;
      occupants.forEach((occupant, index) => {
        const px = centerX + (index - (occupants.length - 1) / 2) * 3.6;
        const addSprite = (texture) => {
          if (texture) texture.encoding = THREE.sRGBEncoding;
          const material = new THREE.SpriteMaterial({
            map: texture || makeInitialsTexture(THREE, occupant),
            transparent: true,
            depthWrite: false,
          });
          const sprite = new THREE.Sprite(material);
          sprite.position.set(px, 2.3, avatarZ);
          sprite.scale.set(3.2, 4.2, 1);
          sprite.userData = { name: String(occupant.displayName || occupant.username || "Avatar"), occupant };
          scene.add(sprite);
        };
        const src = occupant.lookImage || occupant.lookThumbnail || occupant.avatar || occupant.portrait || "";
        if (src) {
          task();
          new THREE.TextureLoader().load(
            imageUrl(src),
            (texture) => {
              addSprite(texture);
              done();
            },
            undefined,
            () => {
              addSprite(null);
              done();
            }
          );
        } else {
          addSprite(null);
        }
      });

      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.target.set(centerX, 2, centerZ);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 6;
      controls.maxDistance = 90;
      controls.maxPolarAngle = Math.PI / 2.05;
      controls.update();

      let animationId = 0;
      const animate = () => {
        animationId = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      };
      animate();

      const resize = () => {
        const w = Math.max(320, container.clientWidth || width);
        const h = Math.max(240, container.clientHeight || height);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      const resizeObserver =
        typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
      resizeObserver?.observe(container);
      window.addEventListener("resize", resize);

      ctx = {
        scene,
        camera,
        renderer,
        controls,
        holder,
        resize,
        resizeObserver,
        timer,
        assets: assets.length,
        avatars: occupants.length,
        getAnimationId: () => animationId,
      };

      window.Cinema3D.debug = () => ({
        ready: true,
        assets: ctx?.assets || 0,
        avatars: ctx?.avatars || 0,
        objects: ctx?.scene?.children?.length || 0,
        size: [ctx?.renderer?.domElement?.width || 0, ctx?.renderer?.domElement?.height || 0],
      });

      if (pending === 0) finish();
    } catch (error) {
      options.onError?.(error?.message || "Falha ao montar o 3D.");
      try {
        stop();
      } catch {
        /* ignora */
      }
    }
  }

  function stop() {
    if (!ctx) {
      window.Cinema3D.debug = emptyDebug;
      return;
    }
    const current = ctx;
    ctx = null;
    try {
      cancelAnimationFrame(current.getAnimationId());
    } catch {
      /* ignora */
    }
    try {
      current.controls?.dispose?.();
    } catch {
      /* ignora */
    }
    try {
      current.resizeObserver?.disconnect?.();
    } catch {
      /* ignora */
    }
    try {
      window.removeEventListener("resize", current.resize);
    } catch {
      /* ignora */
    }
    try {
      disposeScene(current.scene);
    } catch {
      /* ignora */
    }
    try {
      current.renderer?.dispose?.();
    } catch {
      /* ignora */
    }
    try {
      current.holder?.remove?.();
    } catch {
      /* ignora */
    }
    if (current.timer) clearTimeout(current.timer);
    window.Cinema3D.debug = emptyDebug;
  }

  window.Cinema3D = {
    start,
    stop,
    debug: emptyDebug,
  };
})();
