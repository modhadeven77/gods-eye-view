import {
  BoundingSphere,
  CallbackProperty,
  Cartesian3,
  Cartographic,
  Color,
  ConstantPositionProperty,
  EllipsoidGeodesic,
  HeadingPitchRange,
  Math as CesiumMath,
  PolylineOutlineMaterialProperty,
} from 'cesium';
import './overlay.css';

const duration = 6500;
const eventLayers = [
  'news',
  'earthquakes',
  'local-firms',
  'fire-perimeters',
  'weather-cyclones',
];

function validRoute(route) {
  return (
    Array.isArray(route) &&
    route.length >= 2 &&
    route.length <= 6 &&
    route.every(
      (airport) =>
        airport &&
        typeof airport.code === 'string' &&
        Number.isFinite(airport.lat) &&
        Math.abs(airport.lat) <= 90 &&
        Number.isFinite(airport.lon) &&
        Math.abs(airport.lon) <= 180,
    )
  );
}

function planeImage() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.translate(32, 32);
  ctx.scale(1.8, 1.8);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#1769db';
  ctx.lineWidth = 1;
  const path = new Path2D(
    'M 0 -13 Q 2 -13 2 -9 L 2 -4 L 12 3 L 12 6 L 2 2 L 2 8 L 6 11 L 6 13 L 0 11 L -6 13 L -6 11 L -2 8 L -2 2 L -12 6 L -12 3 L -2 -4 L -2 -9 Q -2 -13 0 -13 Z',
  );
  ctx.fill(path);
  ctx.stroke(path);
  return canvas.toDataURL();
}

/** Reuse the independent Sprw frontend and the globe's existing live providers. */
export function mountSprwOverlay({ scene, data, defer }) {
  const viewer = scene.viewer;
  const url = new URL('http://127.0.0.1:4173/');
  url.searchParams.set('embedOrigin', location.origin);
  const host = document.createElement('section');
  host.className = 'sprw-globe';
  host.setAttribute('aria-label', 'Sprw flights and current events');
  const flights = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Flight search';
  const frame = document.createElement('iframe');
  frame.title = 'Sprw flight booking';
  frame.referrerPolicy = 'no-referrer';
  const eventButton = document.createElement('button');
  eventButton.type = 'button';
  eventButton.textContent = 'Load current events';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  flights.append(summary, frame);
  host.append(flights, eventButton, status);
  document.body.append(host);
  flights.addEventListener('toggle', () => {
    if (flights.open && !frame.src) frame.src = url.href;
    if (!flights.open) {
      cancelRoute();
      restoreStack();
    }
  });

  let disposed = false;
  async function loadEvents() {
    eventButton.disabled = true;
    status.textContent = 'Enabling news, earthquakes, wildfires and storms…';
    const results = await Promise.allSettled(
      eventLayers.map((id) =>
        data.dataManager.setEnabled(id, true, { origin: 'user' }),
      ),
    );
    if (disposed) return;
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected' ||
      !data.dataManager.isEnabled(eventLayers[index])
        ? [eventLayers[index]]
        : [],
    );
    status.textContent = failures.length
      ? 'Check unavailable layers in the Layers panel: ' + failures.join(', ')
      : 'Event layers enabled. Source freshness and unavailable feeds appear in Layers.';
    eventButton.textContent = 'Enable current events';
    eventButton.disabled = false;
  }
  eventButton.addEventListener('click', loadEvents);

  const entities = [];
  let animation;
  let routeKey;
  let savedStack;
  let routeGeneration = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function cancelRoute() {
    routeGeneration++;
    cancelAnimationFrame(animation);
    animation = undefined;
    routeKey = undefined;
    for (const entity of entities.splice(0)) viewer.entities.remove(entity);
    viewer.scene.requestRender();
  }

  function restoreStack() {
    const previous = savedStack;
    savedStack = undefined;
    if (previous && previous !== 'esri-imagery') {
      scene.mapStackController
        .setStack(previous, { silent: true })
        .catch(console.warn);
    }
  }

  async function preview(route) {
    const nextKey = route.map((airport) => airport.code).join(':');
    if (nextKey === routeKey) return;
    cancelRoute();
    routeKey = nextKey;
    const generation = routeGeneration;
    const geodesics = route
      .slice(1)
      .map(
        (airport, index) =>
          new EllipsoidGeodesic(
            Cartographic.fromDegrees(route[index].lon, route[index].lat),
            Cartographic.fromDegrees(airport.lon, airport.lat),
          ),
      );
    const lengths = geodesics.map((leg) => leg.surfaceDistance);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    if (!Number.isFinite(total) || total <= 0) return cancelRoute();
    function locationAt(progress) {
      let distance = progress * total;
      let leg = 0;
      while (leg < lengths.length - 1 && distance > lengths[leg])
        distance -= lengths[leg++];
      const location = geodesics[leg].interpolateUsingSurfaceDistance(
        Math.min(distance, lengths[leg]),
      );
      location.height = 12000;
      return location;
    }
    const samples = Array.from({ length: 241 }, (_, index) => {
      const { longitude, latitude, height } = locationAt(index / 240);
      return Cartesian3.fromRadians(longitude, latitude, height);
    });
    let trail = [samples[0]];
    const position = new ConstantPositionProperty(samples[0]);
    const aircraft = viewer.entities.add({
      position,
      billboard: {
        image: planeImage(),
        width: 48,
        height: 48,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entities.push(
      aircraft,
      viewer.entities.add({
        polyline: {
          positions: new CallbackProperty(() => trail, false),
          width: 5,
          material: new PolylineOutlineMaterialProperty({
            color: Color.fromCssColorString('#3c9aff'),
            outlineColor: Color.WHITE,
            outlineWidth: 1,
          }),
        },
      }),
    );
    for (const airport of route)
      entities.push(
        viewer.entities.add({
          position: Cartesian3.fromDegrees(airport.lon, airport.lat, 12000),
          point: {
            pixelSize: 9,
            color: Color.WHITE,
            outlineColor: Color.fromCssColorString('#1769db'),
            outlineWidth: 2,
          },
          label: {
            text: airport.code,
            font: 'bold 14px sans-serif',
            fillColor: Color.WHITE,
            showBackground: true,
          },
        }),
      );

    viewer.camera.cancelFlight();
    viewer.trackedEntity = undefined;
    const sphere = BoundingSphere.fromPoints(samples);
    if (reducedMotion.matches) {
      trail = samples;
      aircraft.show = false;
      viewer.camera.flyToBoundingSphere(sphere, { duration: 0 });
      viewer.scene.requestRender();
      return;
    }
    if (!savedStack) savedStack = scene.mapStackController.getState().activeId;
    await scene.mapStackController.setStack('esri-imagery', { silent: true });
    if (disposed || routeGeneration !== generation) return;
    const start = performance.now();
    const overviewRange = Math.max(400000, sphere.radius * 3);
    function tick(now) {
      if (disposed || routeGeneration !== generation) return;
      const progress = Math.min(1, (now - start) / duration);
      const location = locationAt(progress);
      const current = Cartesian3.fromRadians(
        location.longitude,
        location.latitude,
        location.height,
      );
      position.setValue(current);
      trail = [...samples.slice(0, Math.floor(progress * 240) + 1), current];
      const next = locationAt(Math.min(1, progress + 0.002));
      const heading = Math.atan2(
        CesiumMath.negativePiToPi(next.longitude - location.longitude) *
          Math.cos(location.latitude),
        next.latitude - location.latitude,
      );
      aircraft.billboard.rotation = -heading;
      const blend = Math.min(1, progress / 0.16, (1 - progress) / 0.18);
      const ease = blend * blend * (3 - 2 * blend);
      const range =
        overviewRange *
        (Math.min(700000, overviewRange * 0.28) / overviewRange) ** ease;
      viewer.camera.setView({
        destination: Cartesian3.fromRadians(
          location.longitude,
          location.latitude,
          range,
        ),
        orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
      });
      const canvas = viewer.scene.canvas;
      const panelRight = flights.getBoundingClientRect().right;
      const visibleWidth = canvas.clientWidth - panelRight;
      const fovy = viewer.camera.frustum.fovy;
      if (visibleWidth > 0 && canvas.clientHeight && Number.isFinite(fovy)) {
        const metersPerPixel =
          (2 * range * Math.tan(fovy / 2)) / canvas.clientHeight;
        viewer.camera.moveLeft(panelRight * 0.5 * metersPerPixel);
      }
      viewer.scene.requestRender();
      if (progress < 1 && !reducedMotion.matches)
        animation = requestAnimationFrame(tick);
      else {
        trail = samples;
        aircraft.show = false;
        restoreStack();
        viewer.camera.flyToBoundingSphere(sphere, {
          duration: reducedMotion.matches ? 0 : 0.8,
          offset: new HeadingPitchRange(0, -CesiumMath.PI_OVER_TWO, 0),
        });
        viewer.scene.requestRender();
      }
    }
    animation = requestAnimationFrame(tick);
  }

  function receive(event) {
    if (
      !flights.open ||
      event.source !== frame.contentWindow ||
      event.origin !== url.origin ||
      event.data?.type !== 'sprw:route-preview' ||
      !validRoute(event.data.route)
    )
      return;
    preview(event.data.route).catch((error) => {
      status.textContent =
        'Flight route could not be rendered: ' + error.message;
      cancelRoute();
      restoreStack();
    });
  }
  window.addEventListener('message', receive);
  loadEvents();
  defer(() => {
    disposed = true;
    cancelRoute();
    restoreStack();
    window.removeEventListener('message', receive);
    host.remove();
  });
}
