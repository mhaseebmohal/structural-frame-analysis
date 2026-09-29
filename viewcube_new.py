
import sys
sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', errors='replace')

new_script = """\
<!-- ── 3D ViewCube (Revit/AutoCAD quality) ─────────────────────────── -->
<script>
(function(){
  'use strict';
  var S=140,CX=70,CY=68,R=30;
  var vc,ctx,tooltip;
  var _az=0.65,_el=0.38;
  var _drag=false,_mx0=0,_my0=0,_az0=0,_el0=0;
  var _hover=null;

  var C=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
  var FACES=[
    {v:[4,5,6,7],n:[0,0,1], lbl:'TOP',   snap:{az:0,el:1.56}},
    {v:[0,1,2,3],n:[0,0,-1],lbl:'BOTTOM',snap:{az:0,el:-1.56}},
    {v:[0,1,5,4],n:[0,-1,0],lbl:'FRONT', snap:{az:0,el:0}},
    {v:[3,2,6,7],n:[0,1,0], lbl:'BACK',  snap:{az:3.1416,el:0}},
    {v:[1,2,6,5],n:[1,0,0], lbl:'RIGHT', snap:{az:1.5708,el:0}},
    {v:[0,3,7,4],n:[-1,0,0],lbl:'LEFT',  snap:{az:-1.5708,el:0}}
  ];
  var EDGES=[
    {v:[4,5],f:[0,2],lbl:'Top-Front',   snap:{az:0,      el:0.78}},
    {v:[5,6],f:[0,4],lbl:'Top-Right',   snap:{az:1.5708, el:0.78}},
    {v:[6,7],f:[0,3],lbl:'Top-Back',    snap:{az:3.1416, el:0.78}},
    {v:[7,4],f:[0,5],lbl:'Top-Left',    snap:{az:-1.5708,el:0.78}},
    {v:[0,1],f:[1,2],lbl:'Bot-Front',   snap:{az:0,      el:-0.78}},
    {v:[1,2],f:[1,4],lbl:'Bot-Right',   snap:{az:1.5708, el:-0.78}},
    {v:[2,3],f:[1,3],lbl:'Bot-Back',    snap:{az:3.1416, el:-0.78}},
    {v:[3,0],f:[1,5],lbl:'Bot-Left',    snap:{az:-1.5708,el:-0.78}},
    {v:[0,4],f:[2,5],lbl:'Front-Left',  snap:{az:-0.785, el:0}},
    {v:[1,5],f:[2,4],lbl:'Front-Right', snap:{az:0.785,  el:0}},
    {v:[2,6],f:[3,4],lbl:'Back-Right',  snap:{az:2.356,  el:0}},
    {v:[3,7],f:[3,5],lbl:'Back-Left',   snap:{az:-2.356, el:0}}
  ];
  var CORNERS=[
    {v:0,f:[1,2,5],lbl:'Bot-Front-Left', snap:{az:-0.785,el:-0.615}},
    {v:1,f:[1,2,4],lbl:'Bot-Front-Right',snap:{az:0.785, el:-0.615}},
    {v:2,f:[1,3,4],lbl:'Bot-Back-Right', snap:{az:2.356, el:-0.615}},
    {v:3,f:[1,3,5],lbl:'Bot-Back-Left',  snap:{az:-2.356,el:-0.615}},
    {v:4,f:[0,2,5],lbl:'Top-Front-Left', snap:{az:-0.785,el:0.615}},
    {v:5,f:[0,2,4],lbl:'Top-Front-Right',snap:{az:0.785, el:0.615}},
    {v:6,f:[0,3,4],lbl:'Top-Back-Right', snap:{az:2.356, el:0.615}},
    {v:7,f:[0,3,5],lbl:'Top-Back-Left',  snap:{az:-2.356,el:0.615}}
  ];

  function proj(x,y,z){
    var ca=Math.cos(_az),sa=Math.sin(_az),ce=Math.cos(_el),se=Math.sin(_el);
    var x2=ca*x-sa*y,y2=sa*x+ca*y;
    return{sx:CX+x2*R,sy:CY-(se*y2+ce*z)*R,d:ce*y2-se*z};
  }
  function vd(){return[-Math.sin(_az)*Math.cos(_el),Math.cos(_az)*Math.cos(_el),Math.sin(_el)];}
  function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  function fv(n){return dot(n,vd());}
  function pip(px,py,pts){
    var inside=false;
    for(var i=0,j=pts.length-1;i<pts.length;j=i++){
      var xi=pts[i][0],yi=pts[i][1],xj=pts[j][0],yj=pts[j][1];
      if(((yi>py)!==(yj>py))&&px<(xj-xi)*(py-yi)/(yj-yi)+xi)inside=!inside;
    }
    return inside;
  }
  function segDist(px,py,ax,ay,bx,by){
    var dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
    if(l2<1e-6)return Math.hypot(px-ax,py-ay);
    var t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
    return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
  }

  function hitTest(mx,my){
    var pts=C.map(function(c){return proj(c[0],c[1],c[2]);});
    var v=vd();
    // Home button (top-left)
    if(Math.hypot(mx-14,my-14)<10)return{type:'home',lbl:'Home (Default Isometric)',snap:null};
    // Corners
    for(var ci=0;ci<CORNERS.length;ci++){
      var cr=CORNERS[ci];
      if(fv(FACES[cr.f[0]].n)<-0.12&&fv(FACES[cr.f[1]].n)<-0.12)continue;
      if(Math.hypot(mx-pts[cr.v].sx,my-pts[cr.v].sy)<8)
        return{type:'corner',idx:ci,snap:cr.snap,lbl:cr.lbl};
    }
    // Edges
    for(var ei=0;ei<EDGES.length;ei++){
      var e=EDGES[ei];
      if(fv(FACES[e.f[0]].n)<-0.1&&fv(FACES[e.f[1]].n)<-0.1)continue;
      var p0=pts[e.v[0]],p1=pts[e.v[1]];
      if(segDist(mx,my,p0.sx,p0.sy,p1.sx,p1.sy)<8)
        return{type:'edge',idx:ei,snap:e.snap,lbl:e.lbl};
    }
    // Faces (front first)
    var fs=FACES.map(function(f,i){
      return{i:i,d:f.v.reduce(function(s,v){return s+pts[v].d;},0)/4};
    }).sort(function(a,b){return b.d-a.d;});
    for(var fi=0;fi<fs.length;fi++){
      var F=FACES[fs[fi].i];
      if(fv(F.n)<0.04)continue;
      if(pip(mx,my,F.v.map(function(v){return[pts[v].sx,pts[v].sy];})))
        return{type:'face',idx:fs[fi].i,snap:F.snap,lbl:F.lbl};
    }
    return null;
  }

  function draw(){
    if(!ctx)return;
    ctx.clearRect(0,0,S,S);
    var pts=C.map(function(c){return proj(c[0],c[1],c[2]);});
    var v=vd();

    // Light background
    ctx.save();
    ctx.shadowColor='rgba(0,0,0,0.18)';ctx.shadowBlur=8;ctx.shadowOffsetY=2;
    ctx.beginPath();ctx.roundRect?ctx.roundRect(4,4,S-8,S-8,6):ctx.rect(4,4,S-8,S-8);
    ctx.fillStyle='rgba(235,240,248,0.92)';ctx.fill();
    ctx.restore();
    ctx.beginPath();ctx.roundRect?ctx.roundRect(4,4,S-8,S-8,6):ctx.rect(4,4,S-8,S-8);
    ctx.strokeStyle='rgba(100,130,180,0.35)';ctx.lineWidth=1;ctx.stroke();

    // Faces back to front
    var fs=FACES.map(function(f,i){
      return{i:i,d:f.v.reduce(function(s,vv){return s+pts[vv].d;},0)/4};
    }).sort(function(a,b){return a.d-b.d;});
    fs.forEach(function(item){
      var F=FACES[item.i],vis=fv(F.n);
      if(vis<-0.04)return;
      var isHov=_hover&&_hover.type==='face'&&_hover.idx===item.i;
      var poly=F.v.map(function(vv){return[pts[vv].sx,pts[vv].sy];});
      ctx.beginPath();poly.forEach(function(p,k){if(k===0)ctx.moveTo(p[0],p[1]);else ctx.lineTo(p[0],p[1]);});
      ctx.closePath();
      var bright=Math.max(0.15,vis);
      if(isHov){ctx.fillStyle='rgba(0,114,206,0.88)';}
      else{var g=Math.round(230-bright*40);ctx.fillStyle='rgba('+g+','+g+','+(g+12)+','+(0.5+bright*0.45)+')';}
      ctx.fill();
      ctx.strokeStyle=isHov?'rgba(0,80,180,1)':'rgba(80,110,160,0.55)';
      ctx.lineWidth=isHov?2:1;ctx.stroke();
      if(vis>0.15){
        var cx2=poly.reduce(function(s,p){return s+p[0];},0)/4;
        var cy2=poly.reduce(function(s,p){return s+p[1];},0)/4;
        ctx.save();
        ctx.font=(isHov?'bold ':'bold ')+(vis>0.5?'9':'8')+'px Arial,sans-serif';
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillStyle=isHov?'#fff':(vis>0.5?'#1a237e':'rgba(40,60,130,0.8)');
        ctx.shadowColor=isHov?'rgba(0,0,80,0.4)':'transparent';ctx.shadowBlur=isHov?3:0;
        ctx.fillText(F.lbl,cx2,cy2);ctx.restore();
      }
    });

    // Edges
    EDGES.forEach(function(e,ei){
      if(fv(FACES[e.f[0]].n)<-0.1&&fv(FACES[e.f[1]].n)<-0.1)return;
      var isHov=_hover&&_hover.type==='edge'&&_hover.idx===ei;
      var p0=pts[e.v[0]],p1=pts[e.v[1]];
      ctx.beginPath();ctx.moveTo(p0.sx,p0.sy);ctx.lineTo(p1.sx,p1.sy);
      ctx.strokeStyle=isHov?'rgba(0,114,206,1)':'rgba(80,110,160,0.5)';
      ctx.lineWidth=isHov?4:1;ctx.lineCap='round';
      if(isHov){ctx.shadowColor='rgba(0,114,206,0.5)';ctx.shadowBlur=5;}
      ctx.stroke();ctx.shadowBlur=0;
    });

    // Corners
    CORNERS.forEach(function(cr,ci){
      if(fv(FACES[cr.f[0]].n)<-0.1&&fv(FACES[cr.f[1]].n)<-0.1)return;
      var isHov=_hover&&_hover.type==='corner'&&_hover.idx===ci;
      var cp=pts[cr.v];
      ctx.beginPath();ctx.arc(cp.sx,cp.sy,isHov?5.5:3.5,0,Math.PI*2);
      ctx.fillStyle=isHov?'rgba(0,114,206,1)':'rgba(80,110,165,0.7)';
      if(isHov){ctx.shadowColor='rgba(0,114,206,0.6)';ctx.shadowBlur=7;}
      ctx.fill();ctx.shadowBlur=0;
    });

    // Axis arrows (outside cube, ETABS style)
    [[1,0,0,'X','#e53935'],[0,1,0,'Y','#43a047'],[0,0,1,'Z','#1e88e5']].forEach(function(ax){
      var tip=proj(ax[0]*1.65,ax[1]*1.65,ax[2]*1.65);
      var base=proj(ax[0]*1.08,ax[1]*1.08,ax[2]*1.08);
      ctx.beginPath();ctx.moveTo(base.sx,base.sy);ctx.lineTo(tip.sx,tip.sy);
      ctx.strokeStyle=ax[4];ctx.lineWidth=1.8;ctx.lineCap='round';
      ctx.shadowColor=ax[4];ctx.shadowBlur=2;ctx.stroke();ctx.shadowBlur=0;
      var dx=tip.sx-base.sx,dy=tip.sy-base.sy,len=Math.hypot(dx,dy)||1;
      ctx.beginPath();ctx.moveTo(tip.sx,tip.sy);
      ctx.lineTo(tip.sx-dx/len*5.5-dy/len*2.2,tip.sy-dy/len*5.5+dx/len*2.2);
      ctx.lineTo(tip.sx-dx/len*5.5+dy/len*2.2,tip.sy-dy/len*5.5-dx/len*2.2);
      ctx.closePath();ctx.fillStyle=ax[4];ctx.fill();
      ctx.save();ctx.font='bold 9px Arial';ctx.fillStyle=ax[4];ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.shadowColor='rgba(255,255,255,0.9)';ctx.shadowBlur=3;
      ctx.fillText(ax[3],tip.sx+dx/len*7,tip.sy+dy/len*7);ctx.restore();
    });

    // Compass N
    var az=_az,compR=8,compX=CX,compY=S-12;
    ctx.save();ctx.translate(compX,compY);
    ctx.beginPath();ctx.arc(0,0,compR,0,Math.PI*2);
    ctx.strokeStyle='rgba(80,110,160,0.3)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.beginPath();ctx.moveTo(Math.sin(az)*compR,-Math.cos(az)*compR);
    ctx.lineTo(0,0);ctx.strokeStyle='#c62828';ctx.lineWidth=2;ctx.stroke();
    ctx.beginPath();ctx.moveTo(-Math.sin(az)*compR,Math.cos(az)*compR);
    ctx.lineTo(0,0);ctx.strokeStyle='rgba(80,110,160,0.4)';ctx.lineWidth=1.2;ctx.stroke();
    ctx.font='bold 7px Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#c62828';
    ctx.shadowColor='rgba(255,255,255,0.8)';ctx.shadowBlur=2;
    ctx.fillText('N',Math.sin(az)*(compR+5),-Math.cos(az)*(compR+5));
    ctx.restore();

    // Home button
    var hx=14,hy=14,isHomeHov=_hover&&_hover.type==='home';
    ctx.save();
    ctx.beginPath();ctx.arc(hx,hy,8,0,Math.PI*2);
    ctx.fillStyle=isHomeHov?'rgba(0,114,206,0.9)':'rgba(180,195,220,0.85)';
    ctx.fill();ctx.strokeStyle='rgba(80,120,180,0.4)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.strokeStyle=isHomeHov?'#fff':'rgba(40,60,120,0.8)';
    ctx.lineWidth=1.2;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.beginPath();ctx.moveTo(hx-4,hy+2);ctx.lineTo(hx-4,hy+5);ctx.lineTo(hx+4,hy+5);ctx.lineTo(hx+4,hy+2);ctx.stroke();
    ctx.beginPath();ctx.moveTo(hx-5.5,hy+1.5);ctx.lineTo(hx,hy-4);ctx.lineTo(hx+5.5,hy+1.5);ctx.stroke();
    ctx.restore();
  }

  function showTip(text){
    if(!tooltip)return;
    if(text){tooltip.textContent=text;tooltip.style.display='';}
    else tooltip.style.display='none';
  }

  function snapTo(h){
    var SA=window.SA;
    if(!h)return;
    if(h.type==='home'){
      if(SA&&SA.view3D){SA.view3D.az=0.65;SA.view3D.el=0.38;}
      _az=0.65;_el=0.38;
    } else {
      if(SA&&SA.view3D){SA.view3D.az=h.snap.az;SA.view3D.el=h.snap.el;}
      _az=h.snap.az;_el=h.snap.el;
    }
    SA&&SA.render&&SA.render();
    SA&&SA.toast&&SA.toast('View: '+h.lbl,'info');
    draw();
  }

  function getXY(e){
    var rect=vc.getBoundingClientRect();
    return{mx:(e.clientX-rect.left)*(S/rect.width),my:(e.clientY-rect.top)*(S/rect.height)};
  }

  function init(){
    vc=document.getElementById('view-cube');
    tooltip=document.getElementById('vc-tooltip');
    var wrap=document.getElementById('view-cube-wrap');
    if(!vc)return;
    ctx=vc.getContext('2d');

    setInterval(function(){
      var SA=window.SA;if(!SA)return;
      var show=SA.mode3D;
      if(wrap)wrap.style.display=show?'':'none';
      if(show&&SA.view3D){_az=SA.view3D.az||0;_el=SA.view3D.el||0;}
      if(show)draw();
    },200);

    vc.addEventListener('mousemove',function(e){
      if(_drag){
        var dx=e.clientX-_mx0,dy=e.clientY-_my0;
        _az=_az0+dx*0.013;_el=Math.max(-1.45,Math.min(1.45,_el0-dy*0.013));
        var SA=window.SA;
        if(SA&&SA.view3D){SA.view3D.az=_az;SA.view3D.el=_el;}
        SA&&SA.render&&SA.render();draw();return;
      }
      var xy=getXY(e);
      var h=hitTest(xy.mx,xy.my);
      if(JSON.stringify(h)!==JSON.stringify(_hover)){_hover=h;draw();showTip(h?h.lbl:null);}
      vc.style.cursor=h?'pointer':'grab';
    });
    vc.addEventListener('mouseleave',function(){_hover=null;draw();showTip(null);});
    vc.addEventListener('mousedown',function(e){
      _drag=true;_mx0=e.clientX;_my0=e.clientY;_az0=_az;_el0=_el;
      vc.style.cursor='grabbing';e.preventDefault();
    });
    window.addEventListener('mouseup',function(){_drag=false;vc.style.cursor=_hover?'pointer':'grab';});
    vc.addEventListener('click',function(e){
      if(Math.abs(e.clientX-_mx0)>5||Math.abs(e.clientY-_my0)>5)return;
      var xy=getXY(e);snapTo(hitTest(xy.mx,xy.my));
    });
    draw();
  }
  window.addEventListener('load',function(){setTimeout(init,800);});
})();
</script>

"""

with open(r'C:\Users\Haseeb\Desktop\#\index.html', 'r', encoding='utf-8') as f:
    content = f.read()

old_start = '<!-- ── 3D ViewCube (improved ETABS-style) ────────────────────────── -->'
old_end   = '</script>\n\n<!-- ── Section Manager Logic'

si = content.find(old_start)
ei = content.find(old_end, si)
if si < 0 or ei < 0:
    print(f'ERROR: si={si}, ei={ei}')
else:
    end_of_block = ei + len('</script>')
    content = content[:si] + new_script + content[end_of_block:]
    with open(r'C:\Users\Haseeb\Desktop\#\index.html', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'Done. Replaced {end_of_block-si} chars.')
