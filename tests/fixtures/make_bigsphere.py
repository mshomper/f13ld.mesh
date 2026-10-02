"""Generate fixtures/bigsphere.obj (~125k vertices) for the large-OBJ import test."""
import math, os
nu, nv, R = 250, 500, 8.0
L = []
for i in range(nu + 1):
    th = math.pi * i / nu
    for j in range(nv):
        ph = 2 * math.pi * j / nv
        L.append('v %.5f %.5f %.5f' % (R*math.sin(th)*math.cos(ph), R*math.sin(th)*math.sin(ph), R*math.cos(th)))
for i in range(nu):
    for j in range(nv):
        a = i*nv + j + 1; b = i*nv + (j+1) % nv + 1; c = (i+1)*nv + (j+1) % nv + 1; d = (i+1)*nv + j + 1
        L.append('f %d %d %d' % (a, b, c)); L.append('f %d %d %d' % (a, c, d))
open(os.path.join(os.path.dirname(__file__), 'bigsphere.obj'), 'w').write('\n'.join(L) + '\n')
