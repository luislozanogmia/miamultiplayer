/* Mia — colourful initials avatars (people without a photo). Three option sets from the exploration board:
 *   A 'soft'    — circle, soft radial gradient, initials in the hue's deep shade
 *   B 'square'  — rounded square, pastel tint, initials in the hue (solid:true → full hue, white initials)
 *   C 'outline' — circle, white fill, thin hue ring, initials in the hue
 *   D 'pattern' — circle, solid deep hue, white initials, dot-grid cluster fading in from lower-right
 * miaAvatarColor(name, {px, set:'soft'|'square'|'outline'|'pattern', email, solid}) -> SVG string. Deterministic per name/email.
 */
(function(root){
  // Colours come from the Motes: the pink body (#E9407F base / #FF6FA6 highlight / #B8245C shade) pushed through the same
  // CSS filter the app applies to each bot — hue-rotate(target − 337) saturate(1.08) — for the same 16-hue palette (app.js MOTE_COLOR_PALETTE).
  const MOTE_PALETTE=[337,355,12,27,44,61,84,112,145,169,192,211,231,252,276,305];
  const MOTE_BASE_HUE=337, MOTE_PINK={base:[233,64,127],hi:[255,111,166],shade:[184,36,92]};
  function hueRotate([r,g,b],deg){ // the filter-effects spec matrix, so results match the browser's hue-rotate()
    const a=deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
    const m=[0.213+c*0.787-s*0.213, 0.715-c*0.715-s*0.715, 0.072-c*0.072+s*0.928,
             0.213-c*0.213+s*0.143, 0.715+c*0.285+s*0.140, 0.072-c*0.072-s*0.283,
             0.213-c*0.213-s*0.787, 0.715-c*0.715+s*0.715, 0.072+c*0.928+s*0.072];
    return [m[0]*r+m[1]*g+m[2]*b, m[3]*r+m[4]*g+m[5]*b, m[6]*r+m[7]*g+m[8]*b];
  }
  function saturate([r,g,b],k){
    const m=[0.213+0.787*k,0.715-0.715*k,0.072-0.072*k, 0.213-0.213*k,0.715+0.285*k,0.072-0.072*k, 0.213-0.213*k,0.715-0.715*k,0.072+0.928*k];
    return [m[0]*r+m[1]*g+m[2]*b, m[3]*r+m[4]*g+m[5]*b, m[6]*r+m[7]*g+m[8]*b];
  }
  const clamp=v=>Math.max(0,Math.min(255,Math.round(v)));
  const hex=c=>'#'+c.map(v=>clamp(v).toString(16).padStart(2,'0')).join('');
  const mix=(c,w,t)=>c.map((v,i)=>v*(1-t)+w[i]*t);
  const HUES=MOTE_PALETTE.map(target=>{
    const rot=((target-MOTE_BASE_HUE+540)%360)-180;
    const f=c=>saturate(hueRotate(c,rot),1.08);
    const base=f(MOTE_PINK.base), shade=f(MOTE_PINK.shade);
    const hue=hex(base), deep=hex(shade), pastel=hex(mix(base,[255,255,255],0.82));   // pastel = body colour at 18% over white
    return {hue, pastel, deep, ink:hue, inkDeep:deep, onStrong:'#fff', ring:hue, edge:null};
  });
  // Two neutrals the Motes don't have. `edge` is a hairline so the white one keeps a silhouette on a white page.
  HUES.push({hue:'#111111', pastel:'#E8E5E0', deep:'#111111', ink:'#111111', inkDeep:'#111111', onStrong:'#fff',    ring:'#111111', edge:null});
  HUES.push({hue:'#FFFFFF', pastel:'#FFFFFF', deep:'#FFFFFF', ink:'#111111', inkDeep:'#111111', onStrong:'#111111', ring:'#D6D1C9', edge:'#D6D1C9'});
  function moteHash(str){ let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))>>>0; return h; }
  function hash(s){ let h=2166136261; for(const c of String(s)){ h^=c.charCodeAt(0); h=Math.imul(h,16777619)>>>0; } return h; }
  function initials(name){
    const parts=String(name||'').trim().replace(/@.*$/,'').replace(/[<>()"]/g,' ').split(/[\s._-]+/).filter(Boolean);
    if(!parts.length) return '?';
    if(parts.length===1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();
  }
  const FONT="'Instrument Sans',system-ui,-apple-system,sans-serif";
  function miaAvatarColor(name, opts={}){
    const {px=32, set='soft', email=null, solid=false} = opts;
    const key=String(email||name||'').trim().toLowerCase(); const h=hash(key); const C=HUES[moteHash('color:'+key)%HUES.length]; const {hue,pastel,deep}=C;
    const edge=C.edge?` stroke="${C.edge}" stroke-width="2.5"`:'';
    const txt=initials(name); const id='av'+(h%1e6).toString(36);
    const fs = txt.length===1 ? 46 : 40;
    const label=String(name).replace(/"/g,'&quot;');
    let s=`<svg class="mia-avatar mia-avatar-${set}" viewBox="0 0 100 100" width="${px}" height="${px}" role="img" aria-label="${label}">`;
    let ink=hue;
    if(set==='soft'){
      // light comes from upper-left, deeper tint pools lower-right
      s+=`<defs><radialGradient id="${id}" cx="32%" cy="28%" r="85%"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".5" stop-color="${pastel}"/><stop offset="1" stop-color="${hue}" stop-opacity=".32"/></radialGradient></defs>`;
      s+=`<circle cx="50" cy="50" r="50" fill="${pastel}"/><circle cx="50" cy="50" r="50" fill="url(#${id})"/>`;
      if(C.edge) s+=`<circle cx="50" cy="50" r="48.75" fill="none"${edge}/>`;
      ink=C.inkDeep;
    }else if(set==='square'){
      s+=`<rect width="100" height="100" rx="26" fill="${solid?hue:pastel}"/>`;
      if(C.edge) s+=`<rect x="1.25" y="1.25" width="97.5" height="97.5" rx="25" fill="none"${edge}/>`;
      ink=solid?C.onStrong:C.ink;
    }else if(set==='pattern'){
      // solid deep disc; a 5x5 dot grid in the lower-right quadrant, opacity falling off toward the centre
      s+=`<clipPath id="${id}"><circle cx="50" cy="50" r="50"/></clipPath><circle cx="50" cy="50" r="50" fill="${deep}"/>`;
      if(C.edge) s+=`<circle cx="50" cy="50" r="48.75" fill="none"${edge}/>`;
      if(px>=20){
        // loose scatter: grid cells with a seeded jitter, a few cells skipped, brighter toward the rim
        let seed=h; const rnd=()=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
        const g=[]; const step=7, ox=62, oy=62;
        for(let y=0;y<6;y++) for(let x=0;x<6;x++){
          if(rnd()<0.22) continue;
          const d=Math.hypot(x,y)/7.1;
          const cx=ox+x*step+(rnd()-0.5)*3.5, cy=oy+y*step+(rnd()-0.5)*3.5;
          if(Math.hypot(cx-50,cy-50)>49) continue;
          g.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(1.5+rnd()*0.9).toFixed(1)}" opacity="${(0.10+0.6*d).toFixed(2)}"/>`);
        }
        s+=`<g fill="${C.onStrong}" clip-path="url(#${id})">${g.join('')}</g>`;
      }
      ink=C.onStrong;
    }else{ // outline
      s+=`<circle cx="50" cy="50" r="46.5" fill="#fff" stroke="${C.ring}" stroke-width="${px<24?6:4.5}"/>`;
      ink=C.ink;
    }
    s+=`<text x="50" y="50" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-size="${fs}" font-weight="600" letter-spacing="-0.5" fill="${ink}">${txt}</text>`;
    return s+'</svg>';
  }
  miaAvatarColor.initials=initials; miaAvatarColor.hash=hash; miaAvatarColor.HUES=HUES; miaAvatarColor.MOTE_PALETTE=MOTE_PALETTE; miaAvatarColor.moteHash=moteHash;
  miaAvatarColor.dataUri=(n,o)=>'data:image/svg+xml;utf8,'+encodeURIComponent(miaAvatarColor(n,o));
  if(typeof module!=='undefined') module.exports=miaAvatarColor; root.miaAvatarColor=miaAvatarColor;
})(typeof window!=='undefined'?window:globalThis);
