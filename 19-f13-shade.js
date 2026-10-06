/* ============================================================
   F13LD.mesh · 19-f13-shade.js
   Shared F13LD viewer shading (GLSL), used by 20-raymarcher.js. This block
   is byte-identical in every F13LD tool (tests/shadesync.js checks it);
   change it everywhere at once, never here alone.
   ============================================================ */
'use strict';

// ==== F13LD-SHADE v1 · shared viewer shading (GLSL). Keep this block byte-identical in every F13LD tool. ====
// The shader using it must define  float f13Map(vec3 p)  (distance to the visible
// surface, clipped to the visible domain) BEFORE inserting F13_SHADE_GLSL.
// Works in GLSL ES 1.00 and 3.00. f13Shade() returns a tone-mapped sRGB color.
const F13_SHADE_GLSL = `
uniform float uF13Shadow;uniform float uF13AO;uniform float uF13WarmCool;uniform float uF13Cut;uniform float uF13Lime;uniform float uF13Interact;
vec3 f13Lin(vec3 c){return pow(max(c,vec3(0.0)),vec3(2.2));}
vec3 f13Tone(vec3 c){c=(c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14);return pow(clamp(c,0.0,1.0),vec3(1.0/2.2));}
vec3 f13KeyDir(mat3 R){return normalize(-0.55*R[0]+0.75*R[1]+0.55*R[2]);}
vec3 f13FillDir(mat3 R){return normalize(0.7*R[0]-0.35*R[1]+0.25*R[2]);}
float f13AO(vec3 p,vec3 n,float cell,float eps){
  float occ=0.0;float w=1.0;
  for(int i=0;i<5;i++){float h=cell*(0.04+0.04*float(i))+2.0*eps;float d=f13Map(p+n*h);occ+=max(h-d,0.0)*w;w*=0.8;}
  return clamp(1.0-occ*(3.2/cell),0.0,1.0);
}
float f13Shadow(vec3 ro,vec3 ld,float eps,float tMax){
  float res=1.0;float t=4.0*eps;
  for(int i=0;i<48;i++){float h=f13Map(ro+ld*t);res=min(res,8.0*h/t);t+=clamp(h,0.75*eps,tMax*0.05);if(res<0.02||t>tMax)break;}
  return clamp(res,0.0,1.0);
}
vec3 f13Shade(vec3 base,vec3 p,vec3 n,vec3 rd,mat3 R,bool isCut,float cell,float eps,float tMax){
  vec3 alb=f13Lin(base);
  if(uF13Cut>0.5&&isCut){float lum=dot(alb,vec3(0.2126,0.7152,0.0722));alb=mix(alb,vec3(lum),0.3)*0.9;}
  bool wc=uF13WarmCool>0.5;
  vec3 kD=f13KeyDir(R);vec3 fD=f13FillDir(R);
  vec3 kC=wc?vec3(1.0,0.93,0.82)*1.35:vec3(1.3);
  vec3 fC=wc?vec3(0.30,0.42,0.62)*0.75:vec3(0.5);
  float kd=max(dot(n,kD),0.0);
  float sh=1.0;if(uF13Shadow>0.5&&uF13Interact<0.5&&kd>0.0)sh=f13Shadow(p+n*3.0*eps,kD,eps,tMax);
  float ao=1.0;if(uF13AO>0.5)ao=f13AO(p,n,cell,eps);
  float hemi=0.5+0.5*dot(n,R[1]);
  vec3 amb=mix(vec3(0.10,0.09,0.08),wc?vec3(0.20,0.23,0.30):vec3(0.24),hemi);
  float vf=max(dot(n,-rd),0.0);
  vec3 col=alb*(kC*kd*sh+fC*max(dot(n,fD),0.0)*mix(0.4,1.0,ao)+vec3(0.30)*vf*ao+amb*ao);
  col+=vec3(0.35)*pow(max(dot(n,normalize(kD-rd)),0.0),48.0)*sh;
  float fr=pow(1.0-vf,3.0);
  if(uF13Lime>0.5)col+=f13Lin(vec3(0.784,0.961,0.259))*0.9*fr*ao;else col+=(alb*0.6+vec3(0.06))*fr*ao*0.5;
  return f13Tone(col);
}
vec3 f13ShadeData(vec3 dataCol,vec3 p,vec3 n,vec3 rd,mat3 R,float cell,float eps,float tMax){
  vec3 kD=f13KeyDir(R);float kd=max(dot(n,kD),0.0);
  float sh=1.0;if(uF13Shadow>0.5&&uF13Interact<0.5&&kd>0.0)sh=f13Shadow(p+n*3.0*eps,kD,eps,tMax);
  float ao=1.0;if(uF13AO>0.5)ao=f13AO(p,n,cell,eps);
  float lit=(0.42+0.58*kd*sh)*mix(0.65,1.0,ao)+0.12*max(dot(n,-rd),0.0);
  return clamp(dataCol*lit+vec3(0.18)*pow(max(dot(n,normalize(kD-rd)),0.0),48.0)*sh,0.0,1.0);
}
`;
// ==== /F13LD-SHADE ====
