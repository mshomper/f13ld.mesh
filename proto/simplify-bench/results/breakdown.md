# Simplify time breakdown (today's pipeline, branch m35 / m36 with timing counters)

Machine: AMD Ryzen 7 7700X 8-Core Processor, 16 logical cores, Node v24.21.0. **Everything here ran on one thread** (Node-built jobs, m36 `runBands = null`): the numbers are CPU ms summed over slabs / bands, not wall time on the pool. Meshes: Node-built job (one thread, m34 slabMeshLayers, no DUMPJOB). Slabs per mesh follow m36's job split for 8 workers.

## draft (edge 0.4 mm)

### Per-slab phase (sum over slabs, ms)

| family | slabs | raw tris | slab out tris | simplify | meshopt 1st | meshopt retries | closed chk | seam chk | lock | flip | compact | retries | gave up |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 2 | 49512 | 4376 | 81.3 | 17.8 | 10 | 27.1 | 3.8 | 6.7 | 12.2 | 1.1 | 1 | 0 |
| noise simplex sheet | 2 | 62176 | 10954 | 155.6 | 20.2 | 32.9 | 56 | 6.8 | 11 | 24.4 | 1.5 | 4 | 0 |
| hyperuniform | 2 | 55016 | 12646 | 125.4 | 13.2 | 19.8 | 49.3 | 5 | 9.7 | 25.4 | 1.1 | 3 | 0 |
| spinodoid | 2 | 88762 | 31798 | 374.6 | 25.4 | 84.9 | 155 | 13 | 18.7 | 69.7 | 2.2 | 7 | 0 |
| foam (open, Lloyd) | 2 | 26098 | 20694 | 109.8 | 8.4 | 8.1 | 42.4 | 3.3 | 5.5 | 39.1 | 1.5 | 2 | 0 |
| foam (closed Kelvin) | 2 | 47232 | 34056 | 134.5 | 8.5 | 0 | 40.9 | 4.3 | 6.3 | 70.3 | 2.3 | 0 | 0 |

### Final pass (ms) and result

| family | join | round A | round B | rows | compact | final flip | final pass total | A/B/rows retries | out tris | retries + checks + lock as % of slab simplify |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 1 | 12 | - | 1 | 0 | 2 | 16.4 | 0/-/0 | 2768 | 50.9 |
| noise simplex sheet | 2 | 41 | - | 2 | 1 | 4 | 49.6 | 1/-/0 | 8098 | 63 |
| hyperuniform | 1 | 44 | - | 3 | 0 | 4 | 53.1 | 1/-/0 | 8962 | 60.9 |
| spinodoid | 2 | 151 | - | 7 | 1 | 18 | 179.2 | 2/-/0 | 27916 | 69.1 |
| foam (open, Lloyd) | 2 | 89 | - | 6 | 1 | 8 | 104.1 | 1/-/0 | 20264 | 49.5 |
| foam (closed Kelvin) | 3 | 104 | - | 5 | 1 | 20 | 132.7 | 0/-/0 | 33840 | 33.6 |

### Slab simplify as a share (%), slabs : final pass

| family | slab simplify ms | final pass ms (CPU, incl. flip) | ratio slab : final | field ms (sum) | marching ms (sum) |
|---|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 81.3 | 16.4 | 4.96 : 1 | 31.3 | 22.6 |
| noise simplex sheet | 155.6 | 49.6 | 3.14 : 1 | 192.6 | 25.8 |
| hyperuniform | 125.4 | 53.1 | 2.36 : 1 | 83 | 18.5 |
| spinodoid | 374.6 | 179.2 | 2.09 : 1 | 197.6 | 28.9 |
| foam (open, Lloyd) | 109.8 | 104.1 | 1.05 : 1 | 137.8 | 12 |
| foam (closed Kelvin) | 134.5 | 132.7 | 1.01 : 1 | 109.3 | 16.3 |

## med (edge 0.12 mm)

### Per-slab phase (sum over slabs, ms)

| family | slabs | raw tris | slab out tris | simplify | meshopt 1st | meshopt retries | closed chk | seam chk | lock | flip | compact | retries | gave up |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 6 | 566472 | 35606 | 680.7 | 172 | 28.2 | 286.9 | 40.4 | 49.5 | 73.3 | 3.6 | 1 | 0 |
| noise simplex sheet | 6 | 723020 | 56034 | 1271.9 | 255.2 | 249.3 | 472 | 78.6 | 60.7 | 116.1 | 6 | 6 | 0 |
| hyperuniform | 6 | 637002 | 59038 | 1034.8 | 237.5 | 42.1 | 426.9 | 68.1 | 80.1 | 134.8 | 5.1 | 1 | 0 |
| spinodoid | 6 | 1080582 | 70562 | 3134.2 | 459.7 | 1207.6 | 898 | 191.7 | 122.2 | 182 | 5.6 | 17 | 0 |
| foam (open, Lloyd) | 6 | 601392 | 254464 | 1527.5 | 210.4 | 199.7 | 670.9 | 65.4 | 47.9 | 296.6 | 7.5 | 6 | 0 |
| foam (closed Kelvin) | 6 | 611808 | 59966 | 849.7 | 207.5 | 66.6 | 339.3 | 48.8 | 46.5 | 103 | 3.7 | 2 | 0 |

### Final pass (ms) and result

| family | join | round A | round B | rows | compact | final flip | final pass total | A/B/rows retries | out tris | retries + checks + lock as % of slab simplify |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 5 | 95 | 22 | 22 | 1 | 5 | 149.2 | 2/0/1 | 7938 | 52.4 |
| noise simplex sheet | 9 | 183 | 73 | 49 | 1 | 17 | 332.7 | 3/1/2 | 19710 | 63.3 |
| hyperuniform | 7 | 230 | 69 | 43 | 2 | 11 | 362.1 | 2/0/4 | 23018 | 52.1 |
| spinodoid | 7 | 181 | 46 | 29 | 1 | 18 | 282.6 | 3/0/3 | 21622 | 73.8 |
| foam (open, Lloyd) | 13 | 961 | 491 | 87 | 6 | 86 | 1644.7 | 3/1/4 | 221690 | 61.7 |
| foam (closed Kelvin) | 5 | 209 | 47 | 55 | 1 | 10 | 325.9 | 6/2/3 | 9794 | 53.8 |

### Slab simplify as a share (%), slabs : final pass

| family | slab simplify ms | final pass ms (CPU, incl. flip) | ratio slab : final | field ms (sum) | marching ms (sum) |
|---|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 680.7 | 149.2 | 4.56 : 1 | 877.3 | 225.3 |
| noise simplex sheet | 1271.9 | 332.7 | 3.82 : 1 | 9713.2 | 459.6 |
| hyperuniform | 1034.8 | 362.1 | 2.86 : 1 | 3070.6 | 257.6 |
| spinodoid | 3134.2 | 282.6 | 11.09 : 1 | 7608.1 | 431.2 |
| foam (open, Lloyd) | 1527.5 | 1644.7 | 0.93 : 1 | 4808.3 | 236.1 |
| foam (closed Kelvin) | 849.7 | 325.9 | 2.61 : 1 | 3827.3 | 254.8 |
