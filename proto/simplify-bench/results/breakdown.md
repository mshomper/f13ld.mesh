# Simplify time breakdown (today's pipeline, branch m35 / m36 with timing counters)

Machine: AMD Ryzen 7 7700X 8-Core Processor, 16 logical cores, Node v24.21.0. **Everything here ran on one thread** (Node-built jobs, m36 `runBands = null`): the numbers are CPU ms summed over slabs / bands, not wall time on the pool. Meshes: Node-built job (one thread, m34 slabMeshLayers, no DUMPJOB). Slabs per mesh follow m36's job split for 8 workers.

## draft (edge 0.4 mm)

### Per-slab phase (sum over slabs, ms)

| family | slabs | raw tris | slab out tris | simplify | meshopt 1st | meshopt retries | closed chk | seam chk | lock | flip | compact | retries | gave up |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 2 | 49512 | 4376 | 68.5 | 13.3 | 6.1 | 26.7 | 3.6 | 5.7 | 10.9 | 0.6 | 1 | 0 |
| noise simplex sheet | 2 | 62176 | 10954 | 158.2 | 18.1 | 35.8 | 57.2 | 5.9 | 10.6 | 27.1 | 1.2 | 4 | 0 |
| hyperuniform | 2 | 55016 | 12646 | 125.7 | 13.5 | 20.5 | 49.1 | 4.7 | 8.9 | 25.8 | 1.2 | 3 | 0 |
| spinodoid | 2 | 88762 | 31798 | 369.4 | 24.4 | 85.6 | 155.4 | 15.1 | 16.3 | 64.6 | 2.2 | 7 | 0 |
| foam (open, Lloyd) | 2 | 26098 | 20694 | 99.4 | 7.6 | 8 | 38.2 | 2.8 | 3.9 | 36.2 | 1.5 | 2 | 0 |
| foam (closed Kelvin) | 2 | 47232 | 34056 | 119.5 | 7.8 | 0 | 34.1 | 4.1 | 5.9 | 64.1 | 1.9 | 0 | 0 |

### Final pass (ms) and result

| family | join | round A | round B | rows | compact | final flip | final pass total | A/B/rows retries | out tris | retries + checks + lock as % of slab simplify |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 1 | 13 | - | 1 | 0 | 2 | 16.8 | 0/-/0 | 2768 | 53.9 |
| noise simplex sheet | 1 | 40 | - | 2 | 0 | 5 | 48.3 | 1/-/0 | 8098 | 63.9 |
| hyperuniform | 1 | 47 | - | 3 | 0 | 5 | 56.9 | 1/-/0 | 8962 | 60.9 |
| spinodoid | 3 | 159 | - | 6 | 2 | 19 | 188.2 | 2/-/0 | 27916 | 70.9 |
| foam (open, Lloyd) | 2 | 77 | - | 5 | 1 | 7 | 92.1 | 1/-/0 | 20264 | 49.9 |
| foam (closed Kelvin) | 3 | 101 | - | 6 | 1 | 20 | 130.9 | 0/-/0 | 33840 | 32 |

### Final pass per round: triangles removed and cost (CPU ms, one thread)

| family | round A ms / tris in -> out / ms per 1000 removed | round B | rows pass (tris in) | final flip ms |
|---|---|---|---|---|
| TPMS gyroid sheet | 13 ms / 4376 -> 2768 / 8.1 | - | 1 ms / 0 tris | 2 |
| noise simplex sheet | 40 ms / 10954 -> 8098 / 14.0 | - | 2 ms / 0 tris | 5 |
| hyperuniform | 47 ms / 12646 -> 8962 / 12.8 | - | 3 ms / 0 tris | 5 |
| spinodoid | 159 ms / 31798 -> 27916 / 41.0 | - | 6 ms / 0 tris | 19 |
| foam (open, Lloyd) | 77 ms / 20694 -> 20264 / 179.1 | - | 5 ms / 0 tris | 7 |
| foam (closed Kelvin) | 101 ms / 34056 -> 33840 / 467.6 | - | 6 ms / 0 tris | 20 |

### Slab simplify as a share (%), slabs : final pass

| family | slab simplify ms | final pass ms (CPU, incl. flip) | ratio slab : final | field ms (sum) | marching ms (sum) |
|---|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 68.5 | 16.8 | 4.08 : 1 | 31.3 | 22.6 |
| noise simplex sheet | 158.2 | 48.3 | 3.28 : 1 | 192.6 | 25.8 |
| hyperuniform | 125.7 | 56.9 | 2.21 : 1 | 83 | 18.5 |
| spinodoid | 369.4 | 188.2 | 1.96 : 1 | 197.6 | 28.9 |
| foam (open, Lloyd) | 99.4 | 92.1 | 1.08 : 1 | 137.8 | 12 |
| foam (closed Kelvin) | 119.5 | 130.9 | 0.91 : 1 | 109.3 | 16.3 |

## med (edge 0.12 mm)

### Per-slab phase (sum over slabs, ms)

| family | slabs | raw tris | slab out tris | simplify | meshopt 1st | meshopt retries | closed chk | seam chk | lock | flip | compact | retries | gave up |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 6 | 566472 | 35606 | 672.9 | 167.7 | 28.5 | 291.4 | 39.3 | 43.1 | 73.7 | 2.7 | 1 | 0 |
| noise simplex sheet | 6 | 723020 | 56034 | 1197.5 | 248.7 | 241.3 | 446.7 | 71.7 | 62.5 | 92.6 | 4 | 6 | 0 |
| hyperuniform | 6 | 637002 | 59038 | 1094.1 | 289.1 | 41.2 | 420.2 | 65.8 | 89.2 | 114.8 | 6.2 | 1 | 0 |
| spinodoid | 6 | 1080582 | 70562 | 2737.5 | 392 | 1096 | 801.9 | 160.4 | 91.2 | 135.3 | 4.6 | 17 | 0 |
| foam (open, Lloyd) | 6 | 601392 | 254464 | 2305.5 | 280.9 | 249.6 | 1000.8 | 94.7 | 120.7 | 506 | 11.7 | 6 | 0 |
| foam (closed Kelvin) | 6 | 611808 | 59966 | 1053.9 | 257.3 | 88.4 | 398.9 | 66.7 | 57.5 | 143 | 5.8 | 2 | 0 |

### Final pass (ms) and result

| family | join | round A | round B | rows | compact | final flip | final pass total | A/B/rows retries | out tris | retries + checks + lock as % of slab simplify |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 6 | 111 | 20 | 22 | 0 | 5 | 164.5 | 2/0/1 | 7938 | 53.5 |
| noise simplex sheet | 7 | 162 | 56 | 37 | 1 | 12 | 275.3 | 3/1/2 | 19710 | 64.1 |
| hyperuniform | 7 | 173 | 56 | 29 | 1 | 9 | 275.5 | 2/0/4 | 23018 | 48.6 |
| spinodoid | 6 | 168 | 48 | 30 | 0 | 18 | 271.5 | 3/0/3 | 21622 | 75.8 |
| foam (open, Lloyd) | 18 | 1195 | 606 | 116 | 8 | 175 | 2118.8 | 3/1/4 | 221690 | 58.7 |
| foam (closed Kelvin) | 7 | 260 | 60 | 68 | 1 | 12 | 408.4 | 6/2/3 | 9794 | 52.8 |

### Final pass per round: triangles removed and cost (CPU ms, one thread)

| family | round A ms / tris in -> out / ms per 1000 removed | round B | rows pass (tris in) | final flip ms |
|---|---|---|---|---|
| TPMS gyroid sheet | 111 ms / 35606 -> 13660 / 5.1 | 20 ms / 10464 -> 4886 / 3.6 | 22 ms / 6270 tris | 5 |
| noise simplex sheet | 162 ms / 56034 -> 28530 / 5.9 | 56 ms / 22177 -> 13853 / 6.7 | 37 ms / 10720 tris | 12 |
| hyperuniform | 173 ms / 59038 -> 31834 / 6.4 | 56 ms / 25899 -> 17569 / 6.7 | 29 ms / 12462 tris | 9 |
| spinodoid | 168 ms / 70562 -> 28922 / 4.0 | 48 ms / 19993 -> 12967 / 6.8 | 30 ms / 8459 tris | 18 |
| foam (open, Lloyd) | 1195 ms / 254464 -> 228724 / 46.4 | 606 ms / 153658 -> 147304 / 95.4 | 116 ms / 32481 tris | 175 |
| foam (closed Kelvin) | 260 ms / 59966 -> 18236 / 6.2 | 60 ms / 15067 -> 7811 / 8.3 | 68 ms / 9623 tris | 12 |

### Slab simplify as a share (%), slabs : final pass

| family | slab simplify ms | final pass ms (CPU, incl. flip) | ratio slab : final | field ms (sum) | marching ms (sum) |
|---|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 672.9 | 164.5 | 4.09 : 1 | 877.3 | 225.3 |
| noise simplex sheet | 1197.5 | 275.3 | 4.35 : 1 | 9713.2 | 459.6 |
| hyperuniform | 1094.1 | 275.5 | 3.97 : 1 | 3070.6 | 257.6 |
| spinodoid | 2737.5 | 271.5 | 10.08 : 1 | 7608.1 | 431.2 |
| foam (open, Lloyd) | 2305.5 | 2118.8 | 1.09 : 1 | 4808.3 | 236.1 |
| foam (closed Kelvin) | 1053.9 | 408.4 | 2.58 : 1 | 3827.3 | 254.8 |
