/* ============================================================
   F13LD.mesh · worker/mesh-worker.js
   Mesh worker entry. Launched by 40-mesh-worker-host.js. Loads the
   numbered parts in order into one worker scope — together they are the
   former inline Blob source. To add a recipe family, add its m2x-sdf-*.js
   file here; the file calls registerSDF() (m05-sdf-registry.js), so nothing
   else in the worker needs to change.
   ============================================================ */
importScripts(
  "m00-libs.js"+self.location.search,
  "m05-sdf-registry.js"+self.location.search,
  "m10-noise.js"+self.location.search,
  "m11-grain-fields.js"+self.location.search,
  "m12-reaction-diffusion.js"+self.location.search,
  "m20-sdf-noise-tpms.js"+self.location.search,
  "m21-sdf-beam.js"+self.location.search,
  "m22-sdf-grain.js"+self.location.search,
  "m23-sdf-bundle.js"+self.location.search,
  "m24-sdf-wave.js"+self.location.search,
  "m30-sdf-assembly.js"+self.location.search,
  "m90-onmessage.js"+self.location.search
);
