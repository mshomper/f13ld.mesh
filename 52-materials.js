/* ============================================================
   F13LD.mesh · 52-materials.js
   Material densities for part prep (weight). Copied from F13LD.lab
   15c-materials.js v0.7.2 (reviewed by Matt Shomper 2026-09-29; full
   table and sources in f13ld.lab/docs/MATERIALS.md). Only the fields
   Mesh needs are kept. Lab entries with no published density
   (Ti-24Nb-4Zr-8Sn) are left out. When Lab adds or revises a
   material, copy the change here.
   pp = part-prep process this material is printed with (52 PROCESSES).
   ============================================================ */
'use strict';

// Print processes. critDeg = default overhang limit, measured from the
// build plate (a face tilted less than this from horizontal, facing
// down, needs support). null = the process needs no supports.
const PP_PROCESSES=[
  {id:'lpbf',    name:'Metal laser powder bed (LPBF)',     critDeg:45,   supports:true},
  {id:'ebpbf',   name:'Metal electron beam (EB-PBF)',      critDeg:45,   supports:true},
  {id:'polypbf', name:'Polymer powder bed (SLS / MJF)',    critDeg:null, supports:false},
  {id:'resin',   name:'Resin vat (SLA / DLP)',             critDeg:30,   supports:true},
  {id:'fff',     name:'Material extrusion (FFF)',          critDeg:45,   supports:true}
];

const PP_MATERIALS=[
  {"id":"ti64-g23-lpbf-asbuilt","pp":"lpbf","name":"Ti-6Al-4V ELI (Grade 23)","family":"Titanium","process":"LPBF (SLM 280/500, 30 um, 400 W)","condition":"As-built (no HT)","rho_kgm3":4430},
  {"id":"ti64-g5-lpbf-sr","pp":"lpbf","name":"Ti-6Al-4V (Grade 5)","family":"Titanium","process":"LPBF (EOS M290, 40 um)","condition":"Stress relieved / heat treated 800 C 2 h","rho_kgm3":4410},
  {"id":"ti64-g5-lpbf-hip","pp":"lpbf","name":"Ti-6Al-4V (Grade 5)","family":"Titanium","process":"LPBF (3D Systems DMP)","condition":"HIP","rho_kgm3":4420},
  {"id":"ti64-g23-lpbf-annealed","pp":"lpbf","name":"Ti-6Al-4V ELI (Grade 23)","family":"Titanium","process":"LPBF (Renishaw RenAM 500, 60 um)","condition":"Annealed (per Renishaw)","rho_kgm3":4400},
  {"id":"ti64-g23-lpbf-hip","pp":"lpbf","name":"Ti-6Al-4V ELI (Grade 23)","family":"Titanium","process":"LPBF (SLM 280, 30 um, 400 W)","condition":"HIP 920 C / 1000 bar / 2 h","rho_kgm3":4430},
  {"id":"ti64-g5-ebm-asbuilt","pp":"ebpbf","name":"Ti-6Al-4V (Grade 5)","family":"Titanium","process":"EB-PBF (Arcam Q10plus, 70 um)","condition":"As-built","rho_kgm3":4430},
  {"id":"cpti-g2-lpbf-asbuilt","pp":"lpbf","name":"CP-Ti Grade 2","family":"Titanium","process":"LPBF (EOS M290 400 W)","condition":"As-built","rho_kgm3":4510},
  {"id":"cpti-g2-lpbf-ht","pp":"lpbf","name":"CP-Ti Grade 2","family":"Titanium","process":"LPBF (EOS M290 / M404)","condition":"Heat treated 700 C / 1.5-2 h, Ar","rho_kgm3":4510},
  {"id":"cpti-g1-lpbf-sr","pp":"lpbf","name":"CP-Ti Grade 1","family":"Titanium","process":"LPBF (3D Systems ProX DMP)","condition":"Stress relieved","rho_kgm3":4510},
  {"id":"ti6al7nb-lpbf-asbuilt","pp":"lpbf","name":"Ti-6Al-7Nb","family":"Titanium","process":"LPBF (research, Hein et al. 2022)","condition":"As-built","rho_kgm3":4520},
  {"id":"ti6al7nb-lpbf-sr","pp":"lpbf","name":"Ti-6Al-7Nb","family":"Titanium","process":"LPBF (research, Hein et al. 2022)","condition":"Stress relief 600 C / 4 h (HT3)","rho_kgm3":4520},
  {"id":"ss316l-lpbf-asbuilt","pp":"lpbf","name":"316L stainless","family":"Stainless steel","process":"LPBF (EOS M290, 40 um)","condition":"As-built","rho_kgm3":7970},
  {"id":"ss316l-lpbf-annealed","pp":"lpbf","name":"316L stainless","family":"Stainless steel","process":"LPBF (3D Systems DMP Flex/Factory 350)","condition":"Full anneal","rho_kgm3":8000},
  {"id":"ss174-lpbf-h900","pp":"lpbf","name":"17-4PH stainless","family":"Stainless steel","process":"LPBF (EOS M290, 40 um)","condition":"H900 (per EOS HT)","rho_kgm3":7750},
  {"id":"ss174-lpbf-asbuilt","pp":"lpbf","name":"17-4PH stainless","family":"Stainless steel","process":"LPBF (research, Li et al.)","condition":"As-built","rho_kgm3":7750},
  {"id":"ss155-lpbf-h900","pp":"lpbf","name":"15-5PH stainless (EOS PH1)","family":"Stainless steel","process":"LPBF (EOS M290)","condition":"H900 modified","rho_kgm3":7700},
  {"id":"ss155-lpbf-asbuilt","pp":"lpbf","name":"15-5PH stainless (EOS PH1)","family":"Stainless steel","process":"LPBF (EOS M290)","condition":"As-built","rho_kgm3":7700},
  {"id":"ms1-lpbf-aged","pp":"lpbf","name":"Maraging steel 1.2709 (EOS MS1)","family":"Stainless steel","process":"LPBF (EOS M290, 40 um)","condition":"Aged 490 C / 6 h","rho_kgm3":8050},
  {"id":"in718-lpbf-asbuilt","pp":"lpbf","name":"Inconel 718","family":"Nickel superalloy","process":"LPBF (EOS M290, 40 um)","condition":"As-built","rho_kgm3":8190},
  {"id":"in718-lpbf-sta","pp":"lpbf","name":"Inconel 718","family":"Nickel superalloy","process":"LPBF (EOS M290, 40 um)","condition":"Solution + aged (AMS 5662-type)","rho_kgm3":8190},
  {"id":"in718-lpbf-hip-sta","pp":"lpbf","name":"Inconel 718","family":"Nickel superalloy","process":"LPBF (Nikon SLM NXG 600, vertical)","condition":"HIP + solution + aged","rho_kgm3":8200},
  {"id":"in625-lpbf-sr","pp":"lpbf","name":"Inconel 625","family":"Nickel superalloy","process":"LPBF (EOS M290, 40 um)","condition":"Stress relieved 870 C","rho_kgm3":8440},
  {"id":"hx-lpbf-asbuilt","pp":"lpbf","name":"Hastelloy X","family":"Nickel superalloy","process":"LPBF (EOS M290 400 W)","condition":"As-built","rho_kgm3":8200},
  {"id":"hx-lpbf-hip","pp":"lpbf","name":"Hastelloy X","family":"Nickel superalloy","process":"LPBF (Velo3D, vertical)","condition":"HIP 1177 C","rho_kgm3":8220},
  {"id":"h282-lpbf-ht","pp":"lpbf","name":"Haynes 282","family":"Nickel superalloy","process":"LPBF (EOS M290, 40 um)","condition":"Heat treated (EOS option 1)","rho_kgm3":8300},
  {"id":"alsi10mg-lpbf-asbuilt","pp":"lpbf","name":"AlSi10Mg","family":"Aluminium","process":"LPBF (3D Systems DMP)","condition":"As-built","rho_kgm3":2680},
  {"id":"alsi10mg-lpbf-sr","pp":"lpbf","name":"AlSi10Mg","family":"Aluminium","process":"LPBF (3D Systems DMP)","condition":"Stress relieved","rho_kgm3":2680},
  {"id":"alsi10mg-lpbf-t6","pp":"lpbf","name":"AlSi10Mg","family":"Aluminium","process":"LPBF (GKN Additive, vertical bars, as-built surface)","condition":"T6","rho_kgm3":2670},
  {"id":"scalmalloy-lpbf-aged","pp":"lpbf","name":"Scalmalloy (Al-Mg-Sc-Zr)","family":"Aluminium","process":"LPBF (3D Systems DMP, 30 um)","condition":"Aged 325 C / 4 h","rho_kgm3":2670},
  {"id":"a20x-lpbf-t7","pp":"lpbf","name":"A20X / A205 (Al-Cu-Ag-TiB2)","family":"Aluminium","process":"LPBF (Colibrium M2 Series 5, 400 W)","condition":"T7 (solution + age)","rho_kgm3":2850},
  {"id":"al6061ram2-lpbf-t6","pp":"lpbf","name":"A6061-RAM2 (6061 + reactive additive)","family":"Aluminium","process":"LPBF (3D Systems DMP Flex 350, XY)","condition":"Modified T6","rho_kgm3":2700},
  {"id":"cocrmo-lpbf-asbuilt","pp":"lpbf","name":"CoCrMo (F75-type, EOS MP1)","family":"Cobalt-chrome","process":"LPBF (EOS M290, 40 um)","condition":"As-built","rho_kgm3":8300},
  {"id":"cocrmo-lpbf-ht","pp":"lpbf","name":"CoCrMo (F75-type, EOS MP1)","family":"Cobalt-chrome","process":"LPBF (EOS M290, 40 um)","condition":"Stress relieved + solution annealed","rho_kgm3":8300},
  {"id":"cocrmo-lpbf-hip","pp":"lpbf","name":"CoCrMo (ASTM F75, 3DS LaserForm CoCrF75)","family":"Cobalt-chrome","process":"LPBF (3D Systems DMP)","condition":"HIP","rho_kgm3":8350},
  {"id":"ta-lpbf-asbuilt","pp":"lpbf","name":"Tantalum (unalloyed)","family":"Refractory","process":"LPBF (research, Kustas et al. 2025)","condition":"As-built","rho_kgm3":16680},
  {"id":"nb-lpbf-asbuilt","pp":"lpbf","name":"Niobium (unalloyed)","family":"Refractory","process":"LPBF (research, Griemsmann et al. 2021)","condition":"As-built","rho_kgm3":8580},
  {"id":"grcop42-lpbf-hip","pp":"lpbf","name":"GRCop-42 (Cu-Cr-Nb)","family":"Copper","process":"LPBF (Velo3D, vertical)","condition":"HIP","rho_kgm3":8790},
  {"id":"cucrzr-lpbf-ht","pp":"lpbf","name":"CuCrZr","family":"Copper","process":"LPBF (EOS M400-1)","condition":"Tensile-optimized heat treatment","rho_kgm3":8840},
  {"id":"pa12-sls","pp":"polypbf","name":"PA12 (EOS PA 2200)","family":"Polymer","process":"SLS (EOS)","condition":"As-sintered, dry","rho_kgm3":930},
  {"id":"pa12-mjf","pp":"polypbf","name":"PA12 (HP 3D HR PA 12)","family":"Polymer","process":"MJF (HP)","condition":"As-printed","rho_kgm3":1010},
  {"id":"peek-sls","pp":"polypbf","name":"PEEK (EOS PEEK HP3)","family":"Polymer","process":"HT-SLS (EOS P 800)","condition":"As-sintered (x/y)","rho_kgm3":1315},
  {"id":"peek-fff","pp":"fff","name":"PEEK (Victrex AM 450 FIL)","family":"Polymer","process":"FFF (heated chamber >=150 C)","condition":"As-printed, XY","rho_kgm3":1300},
  {"id":"pekk-sls","pp":"polypbf","name":"PEKK (Arkema Kepstan, research)","family":"Polymer","process":"HT-SLS (Benedetti et al. 2019)","condition":"As-sintered","rho_kgm3":1270},
  {"id":"niti-lpbf","pp":"lpbf","name":"NiTi (Nitinol)","family":"Shape memory","process":"LPBF","condition":"Any (superelastic or shape-memory)","rho_kgm3":6450}
];
function ppFindMaterial(id){ for(let i=0;i<PP_MATERIALS.length;i++) if(PP_MATERIALS[i].id===id) return PP_MATERIALS[i]; return null; }
function ppMaterialsFor(proc){ return PP_MATERIALS.filter(m=>m.pp===proc); }
function ppProcess(id){ for(let i=0;i<PP_PROCESSES.length;i++) if(PP_PROCESSES[i].id===id) return PP_PROCESSES[i]; return PP_PROCESSES[0]; }
