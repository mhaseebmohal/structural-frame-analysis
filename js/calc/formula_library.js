// ══════════════════════════════════════════════════════════════════════════════
//  formula_library.js  —  Searchable Structural Engineering Formula Reference
//  Inspired by Engineering-Smart-Toolkit-Pro formula library pattern
//  40+ formulas across 7 categories with search, copy, bookmark, live solver
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const FormulaLibrary = (() => {

  // ── Formula database ───────────────────────────────────────────────────────
  // Each entry: { id, cat, name, symbol, formula, desc, inputs, solve(inputs), unit }
  const FORMULAS = [

    // ── BEAMS ─────────────────────────────────────────────────────────────────
    { id:'b1', cat:'Beams', name:'Simply Supported — UDL Mid-span Moment',
      symbol:'M_max = wL²/8',
      formula:'M_max = w · L² / 8',
      desc:'Maximum bending moment at mid-span for a simply supported beam with uniform distributed load.',
      ref:'Timoshenko, Strength of Materials',
      inputs:[ {id:'w',label:'w  — UDL',unit:'kN/m'}, {id:'L',label:'L  — span',unit:'m'} ],
      solve:({w,L}) => ({ 'M_max [kNm]': (w*L*L/8).toFixed(3) }),
    },
    { id:'b2', cat:'Beams', name:'Simply Supported — UDL Max Deflection',
      symbol:'δ_max = 5wL⁴/(384EI)',
      formula:'δ_max = 5·w·L⁴ / (384·E·I)',
      desc:'Maximum deflection at mid-span for simply supported beam under UDL. E in GPa, I in cm⁴.',
      ref:'Roark\'s Formulas',
      inputs:[ {id:'w',label:'w  [kN/m]',unit:'kN/m'}, {id:'L',label:'L  [m]',unit:'m'},
               {id:'E',label:'E  [GPa]',unit:'GPa'}, {id:'I',label:'I  [cm⁴]',unit:'cm⁴'} ],
      solve:({w,L,E,I}) => {
        const EI = BeamFormulas.calcEI(E, I); // kN·m²
        return { 'δ_max [mm]': (5*w*Math.pow(L,4)/(384*EI)*1000).toFixed(3) };
      },
    },
    { id:'b3', cat:'Beams', name:'Cantilever — Point Load End Deflection',
      symbol:'δ = PL³/(3EI)',
      formula:'δ_end = P·L³ / (3·E·I)',
      desc:'End deflection for cantilever beam with point load at free end.',
      ref:'Roark\'s Formulas, Table 3',
      inputs:[ {id:'P',label:'P  [kN]',unit:'kN'}, {id:'L',label:'L  [m]',unit:'m'},
               {id:'E',label:'E  [GPa]',unit:'GPa'}, {id:'I',label:'I  [cm⁴]',unit:'cm⁴'} ],
      solve:({P,L,E,I}) => {
        const EI = BeamFormulas.calcEI(E, I);
        return { 'δ_end [mm]': (P*Math.pow(L,3)/(3*EI)*1000).toFixed(3) };
      },
    },
    { id:'b4', cat:'Beams', name:'Cantilever — UDL Max Deflection',
      symbol:'δ = wL⁴/(8EI)',
      formula:'δ_end = w·L⁴ / (8·E·I)',
      desc:'Free-end deflection for cantilever beam under UDL along full length.',
      ref:'Roark\'s Formulas',
      inputs:[ {id:'w',label:'w  [kN/m]',unit:'kN/m'}, {id:'L',label:'L  [m]',unit:'m'},
               {id:'E',label:'E  [GPa]',unit:'GPa'}, {id:'I',label:'I  [cm⁴]',unit:'cm⁴'} ],
      solve:({w,L,E,I}) => {
        const EI = BeamFormulas.calcEI(E, I);
        return { 'δ_end [mm]': (w*Math.pow(L,4)/(8*EI)*1000).toFixed(3) };
      },
    },
    { id:'b5', cat:'Beams', name:'Fixed-Fixed — UDL Fixed End Moment',
      symbol:'M_fixed = wL²/12',
      formula:'M_fixed = w · L² / 12',
      desc:'Fixed end moment at each support for a fixed-fixed beam under UDL.',
      ref:'EC2 / ACI coefficients',
      inputs:[ {id:'w',label:'w  [kN/m]',unit:'kN/m'}, {id:'L',label:'L  [m]',unit:'m'} ],
      solve:({w,L}) => ({ 'M_fixed [kNm]': (w*L*L/12).toFixed(3) }),
    },
    { id:'b6', cat:'Beams', name:'Beam Required Section Modulus',
      symbol:'S_req = M / f',
      formula:'W_req = M_Ed / (f_y / γM0)',
      desc:'Minimum elastic section modulus required to resist a bending moment M_Ed.',
      ref:'EC3 §6.2.5',
      inputs:[ {id:'M',label:'M_Ed  [kNm]',unit:'kNm'}, {id:'fy',label:'fy  [MPa]',unit:'MPa'},
               {id:'gM0',label:'γM0',unit:''} ],
      solve:({M,fy,gM0=1.0}) => ({
        'W_req [cm³]': ((M/(fy*1e3/gM0))*1e6).toFixed(1),
      }),
    },

    // ── COLUMNS ───────────────────────────────────────────────────────────────
    { id:'c1', cat:'Columns', name:'Euler Critical Buckling Load',
      symbol:'P_cr = π²EI/(KL)²',
      formula:'P_cr = π² · E · I / (K·L)²',
      desc:'Elastic critical buckling load for a column. K = effective length factor (0.5 to 2.0).',
      ref:'Euler 1744; EC3 §6.3.1',
      inputs:[ {id:'E',label:'E  [GPa]',unit:'GPa'}, {id:'I',label:'I  [cm⁴]',unit:'cm⁴'},
               {id:'K',label:'K  factor',unit:''}, {id:'L',label:'L  [m]',unit:'m'} ],
      solve:({E,I,K,L}) => {
        const EI = BeamFormulas.calcEI(E, I);
        const Pcr = Math.PI**2 * EI / ((K*L)**2);
        return { 'P_cr [kN]': Pcr.toFixed(2) };
      },
    },
    { id:'c2', cat:'Columns', name:'Column Slenderness Ratio',
      symbol:'λ = KL/r',
      formula:'λ = K·L / r,   r = √(I/A)',
      desc:'Slenderness ratio of a column. r = radius of gyration. EC3 uses non-dimensional λ̄.',
      ref:'EC3 §6.3.1; AISC §E3',
      inputs:[ {id:'K',label:'K  factor',unit:''}, {id:'L',label:'L  [m]',unit:'m'},
               {id:'I',label:'I  [cm⁴]',unit:'cm⁴'}, {id:'A',label:'A  [cm²]',unit:'cm²'} ],
      solve:({K,L,I,A}) => {
        const r_cm = Math.sqrt(I/A);
        const lambda = K*(L*100)/r_cm;  // L in cm
        return { 'r [cm]': r_cm.toFixed(3), 'KL/r': lambda.toFixed(2) };
      },
    },
    { id:'c3', cat:'Columns', name:'Johnson Parabolic Critical Stress',
      symbol:'σ_cr = fy[1 - fy(KL/r)²/(4π²E)]',
      formula:'σ_cr = f_y · [1 − f_y·(KL/r)² / (4π²E)]',
      desc:'Johnson parabola for short/intermediate columns (λ < λc). Transition: λc = π√(E/fy).',
      ref:'AISC LRFD; Engineering-calcs library',
      inputs:[ {id:'fy',label:'fy  [MPa]',unit:'MPa'}, {id:'E',label:'E  [GPa]',unit:'GPa'},
               {id:'KL_r',label:'KL/r',unit:''} ],
      solve:({fy,E,KL_r}) => {
        const E_MPa = E*1e3;
        const lc = Math.PI * Math.sqrt(E_MPa/fy);
        const sigma_cr = fy*(1 - fy*KL_r**2/(4*Math.PI**2*E_MPa));
        return {
          'λc (transition)': lc.toFixed(2),
          'Regime': KL_r < lc ? 'Johnson (short/intermediate)' : 'Euler governs — use Euler formula',
          'σ_cr [MPa]': KL_r < lc ? Math.max(0,sigma_cr).toFixed(2) : 'N/A'
        };
      },
    },

    // ── SECTION PROPERTIES ────────────────────────────────────────────────────
    { id:'s1', cat:'Section Properties', name:'Rectangle — Moment of Inertia',
      symbol:'I = bh³/12',
      formula:'I_xx = b·h³/12,   I_yy = h·b³/12',
      desc:'Second moment of area for a solid rectangular section about its centroidal axes.',
      ref:'Any Mechanics of Materials text',
      inputs:[ {id:'b',label:'b  [mm]',unit:'mm'}, {id:'h',label:'h  [mm]',unit:'mm'} ],
      solve:({b,h}) => ({
        'A [cm²]': (b*h/100).toFixed(2),
        'I_xx [cm⁴]': (b*h**3/12/1e4).toFixed(2),
        'I_yy [cm⁴]': (h*b**3/12/1e4).toFixed(2),
        'S_xx [cm³]': (b*h**2/6/1e3).toFixed(2),
        'Z_xx [cm³]': (b*h**2/4/1e3).toFixed(2),
      }),
    },
    { id:'s2', cat:'Section Properties', name:'Hollow Rectangle — I_xx',
      symbol:'I = (bH³ - bh³)/12',
      formula:'I_xx = (b·H³ − b_i·h_i³)/12',
      desc:'Second moment of area for a hollow rectangular section (box).',
      ref:'Structural Steel Design handbooks',
      inputs:[ {id:'B',label:'B outer [mm]',unit:'mm'}, {id:'H',label:'H outer [mm]',unit:'mm'},
               {id:'bi',label:'b inner [mm]',unit:'mm'}, {id:'hi',label:'h inner [mm]',unit:'mm'} ],
      solve:({B,H,bi,hi}) => ({
        'A [cm²]': ((B*H - bi*hi)/100).toFixed(2),
        'I_xx [cm⁴]': ((B*H**3 - bi*hi**3)/12/1e4).toFixed(2),
        'I_yy [cm⁴]': ((H*B**3 - hi*bi**3)/12/1e4).toFixed(2),
      }),
    },
    { id:'s3', cat:'Section Properties', name:'Circle — Moment of Inertia',
      symbol:'I = πd⁴/64',
      formula:'I = π·d⁴ / 64,   A = π·d²/4',
      desc:'Second moment of area for a solid circular cross-section.',
      ref:'Any Mechanics of Materials text',
      inputs:[ {id:'d',label:'d diameter [mm]',unit:'mm'} ],
      solve:({d}) => ({
        'A [cm²]': (Math.PI*d**2/4/100).toFixed(3),
        'I [cm⁴]': (Math.PI*d**4/64/1e4).toFixed(3),
        'S [cm³]': (Math.PI*d**3/32/1e3).toFixed(3),
        'Z [cm³]': (d**3/6/1e3).toFixed(3),
        'r [cm]': (d/4/10).toFixed(3),
      }),
    },
    { id:'s4', cat:'Section Properties', name:'Parallel Axis Theorem',
      symbol:'I_xx = I_c + A·d²',
      formula:'I_total = I_centroid + A · d²',
      desc:'Transfer of second moment of area from centroidal axis to a parallel axis at distance d.',
      ref:'PLANE repo; Any statics text',
      inputs:[ {id:'Ic',label:'I_c [cm⁴]',unit:'cm⁴'}, {id:'A',label:'A [cm²]',unit:'cm²'},
               {id:'d',label:'d distance [cm]',unit:'cm'} ],
      solve:({Ic,A,d}) => ({ 'I_total [cm⁴]': (Ic + A*d**2).toFixed(3) }),
    },
    { id:'s5', cat:'Section Properties', name:'Radius of Gyration',
      symbol:'r = √(I/A)',
      formula:'r = √(I / A)',
      desc:'Radius of gyration — measure of distribution of area about an axis.',
      ref:'EC3 §6.3.1',
      inputs:[ {id:'I',label:'I [cm⁴]',unit:'cm⁴'}, {id:'A',label:'A [cm²]',unit:'cm²'} ],
      solve:({I,A}) => ({ 'r [cm]': Math.sqrt(I/A).toFixed(4) }),
    },

    // ── CONNECTIONS ───────────────────────────────────────────────────────────
    { id:'cn1', cat:'Connections', name:'Bolt Shear Resistance (EC3)',
      symbol:'F_v,Rd = 0.6·fub·A/γM2',
      formula:'F_v,Rd = 0.6 · f_ub · A_s / γM2',
      desc:'Design shear resistance of a single bolt (Category A: bearing type, shear plane through shank).',
      ref:'EC3-1-8 Table 3.4',
      inputs:[ {id:'fub',label:'fub bolt UTS [MPa]',unit:'MPa'}, {id:'As',label:'A_s [mm²]',unit:'mm²'},
               {id:'gM2',label:'γM2',unit:''} ],
      solve:({fub,As,gM2=1.25}) => ({ 'F_v,Rd [kN]': (0.6*fub*As/gM2/1000).toFixed(3) }),
    },
    { id:'cn2', cat:'Connections', name:'Bolt Bearing Resistance (EC3)',
      symbol:'F_b,Rd = k1·αb·fu·d·t/γM2',
      formula:'F_b,Rd = k1·αb·fu·d·t / γM2',
      desc:'Design bearing resistance of a bolt on a plate. αb = min(e1/3d0, p1/3d0−1/4, fub/fu, 1). k1 = min(2.8·e2/d0−1.7, 1.4·p2/d0−1.7, 2.5).',
      ref:'EC3-1-8 §3.6.1 Eq.3.6',
      inputs:[ {id:'fu',label:'fu plate UTS [MPa]',unit:'MPa'}, {id:'d',label:'d bolt dia [mm]',unit:'mm'},
               {id:'t',label:'t plate thick [mm]',unit:'mm'}, {id:'ab',label:'αb',unit:''}, {id:'k1',label:'k1',unit:''} ],
      solve:({fu,d,t,ab,k1}) => ({ 'F_b,Rd [kN]': (k1*ab*fu*d*t/1.25/1000).toFixed(3) }),
    },
    { id:'cn3', cat:'Connections', name:'Fillet Weld Resistance (EC3)',
      symbol:'F_w,Rd = fu·a·l/(√3·βw·γM2)',
      formula:'F_w,Rd = f_u · a · l_eff / (√3 · β_w · γM2)',
      desc:'Design resistance of fillet weld per unit length. βw = correlation factor: 0.8 (S235), 0.85 (S275), 0.90 (S355), 1.0 (S420/460).',
      ref:'EC3-1-8 §4.5.3',
      inputs:[ {id:'fu',label:'fu [MPa]',unit:'MPa'}, {id:'a',label:'throat a [mm]',unit:'mm'},
               {id:'l',label:'length l [mm]',unit:'mm'}, {id:'bw',label:'βw',unit:''} ],
      solve:({fu,a,l,bw}) => ({
        'F_w,Rd [kN]': (fu*a*l/(Math.sqrt(3)*bw*1.25)/1000).toFixed(3),
        'f_vw,d [MPa]': (fu/(Math.sqrt(3)*bw*1.25)).toFixed(2),
      }),
    },
    { id:'cn4', cat:'Connections', name:'Weld Throat Size from Leg',
      symbol:'a = 0.707 · s',
      formula:'a = s / √2 ≈ 0.707 · s',
      desc:'Effective throat dimension for a 45° equal leg fillet weld.',
      ref:'AWS D1.1; EC3-1-8 §4.3',
      inputs:[ {id:'s',label:'leg size s [mm]',unit:'mm'} ],
      solve:({s}) => ({ 'throat a [mm]': (s/Math.sqrt(2)).toFixed(2) }),
    },

    // ── STEEL DESIGN ──────────────────────────────────────────────────────────
    { id:'st1', cat:'Steel Design', name:'Plastic Section Modulus (rectangle)',
      symbol:'Z_pl = b·h²/4',
      formula:'Z_pl,x = b · h² / 4',
      desc:'Plastic section modulus for a solid rectangular section.',
      ref:'EC3; AISC Steel Construction Manual',
      inputs:[ {id:'b',label:'b [mm]',unit:'mm'}, {id:'h',label:'h [mm]',unit:'mm'} ],
      solve:({b,h}) => ({ 'Z_pl [cm³]': (b*h**2/4/1e3).toFixed(3) }),
    },
    { id:'st2', cat:'Steel Design', name:'EC3 Section Class ε-factor',
      symbol:'ε = √(235/fy)',
      formula:'ε = √(235 / f_y)',
      desc:'Epsilon factor for EC3 Table 5.2 section classification. ε=1.0 for S235, ε=0.924 for S275, ε=0.814 for S355.',
      ref:'EC3-1-1 Table 5.2',
      inputs:[ {id:'fy',label:'fy [MPa]',unit:'MPa'} ],
      solve:({fy}) => ({
        'ε': Math.sqrt(235/fy).toFixed(4),
        'Flange Class 1 limit  c/tf ≤': (9*Math.sqrt(235/fy)).toFixed(2),
        'Flange Class 2 limit  c/tf ≤': (10*Math.sqrt(235/fy)).toFixed(2),
        'Flange Class 3 limit  c/tf ≤': (14*Math.sqrt(235/fy)).toFixed(2),
        'Web Class 1 limit  c/tw ≤': (72*Math.sqrt(235/fy)).toFixed(2),
        'Web Class 3 limit  c/tw ≤': (124*Math.sqrt(235/fy)).toFixed(2),
      }),
    },
    { id:'st3', cat:'Steel Design', name:'LTB Non-dim. Slenderness',
      symbol:'λ_LT = √(W_pl·fy/Mcr)',
      formula:'λ̄_LT = √(W_pl,y · f_y / M_cr)',
      desc:'Non-dimensional LTB slenderness. If λ̄_LT ≤ 0.4 → no LTB, χ_LT = 1.0.',
      ref:'EC3-1-1 §6.3.2',
      inputs:[ {id:'Wpl',label:'W_pl,y [cm³]',unit:'cm³'}, {id:'fy',label:'fy [MPa]',unit:'MPa'},
               {id:'Mcr',label:'M_cr [kNm]',unit:'kNm'} ],
      solve:({Wpl,fy,Mcr}) => {
        const lambdaLT = Math.sqrt(Wpl*1e-6*fy*1e3/Mcr);
        return {
          'λ̄_LT': lambdaLT.toFixed(4),
          'LTB governs?': lambdaLT > 0.4 ? `Yes (λ̄_LT=${lambdaLT.toFixed(3)} > 0.4)` : 'No — χ_LT = 1.0'
        };
      },
    },
    { id:'st4', cat:'Steel Design', name:'Shear Area — I-Section (EC3)',
      symbol:'Av = A − 2b·tf + (tw+2r)·tf',
      formula:'A_v = A − 2·b_f·t_f + (t_w + 2·r)·t_f',
      desc:'Effective shear area for rolled I/H sections resisting vertical shear (EC3 §6.2.6).',
      ref:'EC3-1-1 §6.2.6(3)',
      inputs:[ {id:'A',label:'A [cm²]',unit:'cm²'}, {id:'bf',label:'b_f [mm]',unit:'mm'},
               {id:'tf',label:'t_f [mm]',unit:'mm'}, {id:'tw',label:'t_w [mm]',unit:'mm'},
               {id:'r',label:'r root [mm]',unit:'mm'} ],
      solve:({A,bf,tf,tw,r=0}) => ({
        'A_v [cm²]': (A - 2*(bf/10)*(tf/10) + ((tw+2*r)/10)*(tf/10)).toFixed(3),
      }),
    },

    // ── CONCRETE ──────────────────────────────────────────────────────────────
    { id:'rc1', cat:'Concrete (EC2)', name:'Design Compressive Strength',
      symbol:'fcd = αcc·fck/γC',
      formula:'f_cd = α_cc · f_ck / γ_C',
      desc:'Design value of concrete compressive strength. αcc = 0.85 (EN), γC = 1.5 (persistent).',
      ref:'EC2-1-1 §3.1.6',
      inputs:[ {id:'fck',label:'fck [MPa]',unit:'MPa'}, {id:'acc',label:'αcc',unit:''}, {id:'gC',label:'γC',unit:''} ],
      solve:({fck,acc=0.85,gC=1.5}) => ({ 'f_cd [MPa]': (acc*fck/gC).toFixed(3) }),
    },
    { id:'rc2', cat:'Concrete (EC2)', name:'Minimum Slab Thickness (deflection)',
      symbol:'d_min = L/20 to L/35',
      formula:'d_min = L / (l/d basic ratio)',
      desc:'Approximate minimum effective depth for deflection control. l/d = 20 (SS), 26 (end span), 30 (internal), 12 (cantilever).',
      ref:'EC2-1-1 §7.4',
      inputs:[ {id:'L',label:'L [m]',unit:'m'}, {id:'ld',label:'l/d ratio',unit:''} ],
      solve:({L,ld}) => ({
        'd_min [mm]': ((L*1000)/ld).toFixed(0),
        'h_min [mm] (≈d+50)': ((L*1000)/ld + 50).toFixed(0),
      }),
    },
    { id:'rc3', cat:'Concrete (EC2)', name:'Bending — Required Reinforcement',
      symbol:'As = M/(0.87·fy·z)',
      formula:'A_s,req = M_Ed / (0.87 · f_yk · z)',
      desc:'Approximate required tensile reinforcement area. z ≈ 0.9d for under-reinforced sections.',
      ref:'EC2-1-1 §6.1 (simplified)',
      inputs:[ {id:'M',label:'M_Ed [kNm]',unit:'kNm'}, {id:'fyk',label:'fyk [MPa]',unit:'MPa'},
               {id:'z',label:'z lever arm [m]',unit:'m'} ],
      solve:({M,fyk,z}) => ({
        'A_s,req [mm²]': (M*1e6/(0.87*fyk*z*1000)).toFixed(0),
        'A_s,req [cm²]': (M*1e6/(0.87*fyk*z*1000)/100).toFixed(2),
      }),
    },
    { id:'rc4', cat:'Concrete (EC2)', name:'Min Reinforcement Ratio',
      symbol:'ρ_min = 0.26·fctm/fyk',
      formula:'A_s,min = max(0.26·f_ctm/f_yk, 0.0013)·b·d',
      desc:'Minimum tension steel for beams per EC2. fctm = 0.30·fck^(2/3) for fck ≤ 50 MPa.',
      ref:'EC2-1-1 §9.2.1.1',
      inputs:[ {id:'fck',label:'fck [MPa]',unit:'MPa'}, {id:'fyk',label:'fyk [MPa]',unit:'MPa'},
               {id:'b',label:'b width [mm]',unit:'mm'}, {id:'d',label:'d eff. depth [mm]',unit:'mm'} ],
      solve:({fck,fyk,b,d}) => {
        const fctm = 0.30*Math.pow(fck,2/3);
        const rho  = Math.max(0.26*fctm/fyk, 0.0013);
        return {
          'f_ctm [MPa]': fctm.toFixed(3),
          'ρ_min': rho.toFixed(5),
          'A_s,min [mm²]': (rho*b*d).toFixed(0),
        };
      },
    },
    { id:'rc5', cat:'Concrete (EC2)', name:'Shear Capacity without Steel',
      symbol:'VRdc = [0.12·k·(100ρ·fck)^(1/3)]·bw·d',
      formula:'V_Rd,c = [C_Rd,c·k·(100·ρ_l·f_ck)^(1/3) + k_1·σ_cp]·b_w·d',
      desc:'Shear resistance without shear reinforcement. k=1+√(200/d)≤2. CRd,c=0.18/γC=0.12.',
      ref:'EC2-1-1 §6.2.2 Eq.6.2a',
      inputs:[ {id:'fck',label:'fck [MPa]',unit:'MPa'}, {id:'rho',label:'ρl (steel ratio)',unit:''},
               {id:'bw',label:'b_w [mm]',unit:'mm'}, {id:'d',label:'d [mm]',unit:'mm'} ],
      solve:({fck,rho,bw,d}) => {
        const k = Math.min(2, 1 + Math.sqrt(200/d));
        const VRdc = (0.12*k*Math.pow(100*rho*fck,1/3) * bw * d)/1000;
        return {
          'k = 1+√(200/d)': k.toFixed(3),
          'V_Rd,c [kN]': VRdc.toFixed(3),
          'v_min [MPa]': (0.035*Math.pow(k,1.5)*Math.sqrt(fck)).toFixed(4),
        };
      },
    },

    // ── GEOTECHNICAL ──────────────────────────────────────────────────────────
    { id:'g1', cat:'Geotechnical', name:'Bearing Capacity — Terzaghi (strip)',
      symbol:'qu = c·Nc + q·Nq + 0.5·γ·B·Nγ',
      formula:'q_u = c·N_c + q·N_q + 0.5·γ·B·N_γ',
      desc:'Ultimate bearing capacity for strip footing (Terzaghi general equation).',
      ref:'Terzaghi 1943; Das Principles of Geotechnical Engineering',
      inputs:[ {id:'c',label:"c' cohesion [kPa]",unit:'kPa'}, {id:'q',label:'q surcharge [kPa]',unit:'kPa'},
               {id:'phi',label:"φ' angle [°]",unit:'°'}, {id:'gam',label:'γ soil [kN/m³]',unit:'kN/m³'},
               {id:'B',label:'B footing [m]',unit:'m'} ],
      solve:({c,q,phi,gam,B}) => {
        const p = phi*Math.PI/180;
        const Nq = Math.exp(Math.PI*Math.tan(p))*Math.tan(Math.PI/4+p/2)**2;
        const Nc = (Nq-1)/Math.tan(p) || 5.14;
        const Ng = 2*(Nq+1)*Math.tan(p);
        const qu = c*Nc + q*Nq + 0.5*gam*B*Ng;
        return { 'N_c': Nc.toFixed(2), 'N_q': Nq.toFixed(2), 'N_γ': Ng.toFixed(2), 'q_u [kPa]': qu.toFixed(1) };
      },
    },
    { id:'g2', cat:'Geotechnical', name:'Active Earth Pressure (Rankine)',
      symbol:'Ka = tan²(45-φ/2)',
      formula:'K_a = tan²(45° − φ/2),   σ_a = Ka·γ·H − 2c·√Ka',
      desc:'Rankine active earth pressure coefficient and active pressure at depth H.',
      ref:'Rankine 1857; Das §11.3',
      inputs:[ {id:'phi',label:"φ' [°]",unit:'°'}, {id:'gam',label:'γ [kN/m³]',unit:'kN/m³'},
               {id:'H',label:'H depth [m]',unit:'m'}, {id:'c',label:"c' [kPa]",unit:'kPa'} ],
      solve:({phi,gam,H,c=0}) => {
        const Ka = Math.tan((45-phi/2)*Math.PI/180)**2;
        const Pa  = Ka*gam*H - 2*c*Math.sqrt(Ka);
        const Ptotal = 0.5*Ka*gam*H**2 - 2*c*Math.sqrt(Ka)*H;
        return { 'K_a': Ka.toFixed(4), 'σ_a at H [kPa]': Pa.toFixed(2), 'P total [kN/m]': Ptotal.toFixed(2) };
      },
    },
    { id:'g3', cat:'Geotechnical', name:'Settlement — Elastic (Boussinesq)',
      symbol:'S = q·B·(1-ν²)·Iw/E',
      formula:'S = q · B · (1 − ν²) · I_w / E_s',
      desc:'Immediate elastic settlement of a flexible footing on elastic soil. Iw ≈ 0.56 (centre, circular), 0.82 (corner, square).',
      ref:'Boussinesq; Das §11.9',
      inputs:[ {id:'q',label:'q stress [kPa]',unit:'kPa'}, {id:'B',label:'B [m]',unit:'m'},
               {id:'nu',label:'ν Poisson',unit:''}, {id:'Es',label:'Es [MPa]',unit:'MPa'},
               {id:'Iw',label:'Iw factor',unit:''} ],
      solve:({q,B,nu=0.3,Es,Iw=0.56}) => ({
        'S [mm]': (q*B*(1-nu**2)*Iw/(Es*1e3)*1000).toFixed(2),
      }),
    },

    // ── DYNAMICS ──────────────────────────────────────────────────────────────
    { id:'d1', cat:'Dynamics', name:'SDOF Natural Frequency',
      symbol:'fn = (1/2π)·√(K/m)',
      formula:'f_n = (1/2π) · √(K/m)',
      desc:'Natural frequency of a single-degree-of-freedom (SDOF) system.',
      ref:'Chopra "Dynamics of Structures" §2.1',
      inputs:[ {id:'K',label:'K stiffness [kN/m]',unit:'kN/m'}, {id:'m',label:'m mass [tonne]',unit:'t'} ],
      solve:({K,m}) => {
        const omega = Math.sqrt(K/m);
        return { 'ω [rad/s]': omega.toFixed(4), 'f_n [Hz]': (omega/(2*Math.PI)).toFixed(4), 'T [s]': (2*Math.PI/omega).toFixed(4) };
      },
    },
    { id:'d2', cat:'Dynamics', name:'Seismic Base Shear (EC8)',
      symbol:'Fb = Sd(T1)·m·λ',
      formula:'F_b = S_d(T_1) · m · λ',
      desc:'Seismic base shear by lateral force method. λ=0.85 if T1≤2TC and >2 storeys, else 1.0. Sd is design spectrum.',
      ref:'EC8-1 §4.3.3.2',
      inputs:[ {id:'Sd',label:'Sd(T1) [m/s²]',unit:'m/s²'}, {id:'m',label:'total mass [tonne]',unit:'t'},
               {id:'lam',label:'λ (0.85 or 1.0)',unit:''} ],
      solve:({Sd,m,lam=0.85}) => ({ 'F_b [kN]': (Sd*m*lam).toFixed(2) }),
    },
    { id:'d3', cat:'Dynamics', name:'Damped Natural Frequency',
      symbol:'ωd = ωn·√(1-ζ²)',
      formula:'ω_d = ω_n · √(1 − ζ²)',
      desc:'Damped natural frequency. ζ = damping ratio (typically 0.02-0.05 for steel, 0.05-0.07 for concrete).',
      ref:'Chopra §2.2',
      inputs:[ {id:'fn',label:'f_n [Hz]',unit:'Hz'}, {id:'zeta',label:'ζ damping ratio',unit:''} ],
      solve:({fn,zeta}) => {
        const wn = 2*Math.PI*fn;
        const wd = wn*Math.sqrt(1-zeta**2);
        return { 'ω_d [rad/s]': wd.toFixed(4), 'f_d [Hz]': (wd/(2*Math.PI)).toFixed(4) };
      },
    },

    // ── LOADS ─────────────────────────────────────────────────────────────────
    { id:'l1', cat:'Loads', name:'EC0 ULS Combination (STR)',
      symbol:'1.35G + 1.5Q + 1.5ψ₀·W',
      formula:'E_d = 1.35·G_k + 1.5·Q_k + 1.5·ψ₀·W_k',
      desc:'EC0 fundamental combination for persistent/transient design situations (ULS). ψ₀=0.7 (LL office), 0.6 (WL).',
      ref:'EN 1990 Eq.6.10 (or 6.10a/b)',
      inputs:[ {id:'G',label:'G_k dead [kN or kNm]',unit:''}, {id:'Q',label:'Q_k live',unit:''},
               {id:'W',label:'W_k wind',unit:''}, {id:'psi0',label:'ψ₀ for W',unit:''} ],
      solve:({G,Q,W,psi0=0.6}) => ({
        'E_d (Eq.6.10)': (1.35*G + 1.5*Q + 1.5*psi0*W).toFixed(3),
        'E_d (Eq.6.10a)': (1.35*G + 1.5*psi0*Q + 1.5*0.6*W).toFixed(3),
        'E_d (Eq.6.10b)': (0.925*1.35*G + 1.5*Q + 1.5*psi0*W).toFixed(3),
        'Min governing': 'Max of above',
      }),
    },
    { id:'l2', cat:'Loads', name:'Snow Load — EC1',
      symbol:'s = μ·Ce·Ct·sk',
      formula:'s = μ_i · C_e · C_t · s_k',
      desc:'Ground-to-roof snow load conversion. μ1=0.8 (flat to 30°), Ce=Ct=1.0 normal conditions.',
      ref:'EC1-1-3 §5.2',
      inputs:[ {id:'sk',label:'s_k ground [kN/m²]',unit:'kN/m²'}, {id:'mu',label:'μi shape coeff',unit:''},
               {id:'Ce',label:'Ce exposure',unit:''}, {id:'Ct',label:'Ct thermal',unit:''} ],
      solve:({sk,mu=0.8,Ce=1.0,Ct=1.0}) => ({ 's [kN/m²]': (mu*Ce*Ct*sk).toFixed(3) }),
    },
    { id:'l3', cat:'Loads', name:'Wind Pressure — EC1',
      symbol:'w = qp·Cpe',
      formula:'w_e = q_p(z_e) · c_pe',
      desc:'Net external wind pressure on a surface. qp = peak velocity pressure = 0.5·ρ·vb²·ce(z).',
      ref:'EC1-1-4 §5.2',
      inputs:[ {id:'vb',label:'v_b,0 [m/s]',unit:'m/s'}, {id:'cz',label:'c_e(z) exposure',unit:''},
               {id:'cpe',label:'c_pe pressure coeff',unit:''}, {id:'cdir',label:'c_dir (=1.0)',unit:''} ],
      solve:({vb,cz=1.5,cpe=0.8,cdir=1.0}) => {
        const qp = 0.5*1.25*(vb*cdir)**2 * cz / 1000; // kN/m²
        return { 'q_p [kN/m²]': qp.toFixed(4), 'w_e [kN/m²]': (qp*cpe).toFixed(4) };
      },
    },
  ];

  // ── Bookmarks (localStorage) ───────────────────────────────────────────────
  const STORAGE_KEY = 'fl_bookmarks';
  let bookmarks = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  const saveBookmarks = () => localStorage.setItem(STORAGE_KEY, JSON.stringify([...bookmarks]));

  // ── Build dialog HTML ──────────────────────────────────────────────────────
  function buildDialogHTML() {
    return `
<div style="display:flex;gap:0;height:540px">

  <!-- Left: search + list -->
  <div style="width:260px;flex-shrink:0;border-right:1px solid var(--border-tbl);display:flex;flex-direction:column">
    <div style="padding:8px">
      <input type="text" id="fl-search" placeholder="🔍  search formulas…"
        style="width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--bg-input);color:var(--text)">
    </div>
    <div id="fl-cats" style="padding:0 8px 6px;display:flex;flex-wrap:wrap;gap:3px"></div>
    <div id="fl-list" style="flex:1;overflow-y:auto;padding:4px 0"></div>
    <div style="padding:6px 8px;font-size:10px;color:var(--text-sec);border-top:1px solid var(--border-tbl)">
      <span id="fl-count">${FORMULAS.length}</span> formulas &nbsp;|&nbsp;
      <span style="cursor:pointer;color:#1565C0" id="fl-show-bookmarks">★ Bookmarks</span>
    </div>
  </div>

  <!-- Right: detail + solver -->
  <div id="fl-detail" style="flex:1;overflow-y:auto;padding:12px 16px">
    <p style="color:#888;font-size:12px;margin-top:30px;text-align:center">Select a formula from the list.</p>
  </div>
</div>`;
  }

  // ── Wire dialog ────────────────────────────────────────────────────────────
  function wireDialog() {
    let activeCat = 'All';
    let activeId  = null;
    let showBm    = false;

    const $search = document.getElementById('fl-search');
    const $cats   = document.getElementById('fl-cats');
    const $list   = document.getElementById('fl-list');
    const $detail = document.getElementById('fl-detail');
    const $count  = document.getElementById('fl-count');

    // Render category buttons
    const cats = ['All', ...new Set(FORMULAS.map(f => f.cat))];
    $cats.innerHTML = cats.map(c =>
      `<button class="fl-cat-btn${c==='All'?' fl-active':''}" data-cat="${c}"
        style="font-size:10px;padding:2px 7px;border:1px solid var(--border);border-radius:10px;
        background:${c==='All'?'#1565C0':'var(--bg-pane)'};color:${c==='All'?'#fff':'var(--text)'};cursor:pointer"
      >${c}</button>`).join('');

    $cats.addEventListener('click', e => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      activeCat = btn.dataset.cat;
      showBm = false;
      [...$cats.querySelectorAll('[data-cat]')].forEach(b => {
        b.style.background = b.dataset.cat === activeCat ? '#1565C0' : 'var(--bg-pane)';
        b.style.color      = b.dataset.cat === activeCat ? '#fff' : 'var(--text)';
      });
      renderList();
    });

    document.getElementById('fl-show-bookmarks').addEventListener('click', () => {
      showBm = !showBm;
      renderList();
    });

    function getVisible() {
      const q = ($search.value || '').toLowerCase().trim();
      return FORMULAS.filter(f => {
        if (showBm && !bookmarks.has(f.id)) return false;
        if (activeCat !== 'All' && f.cat !== activeCat) return false;
        if (q) return [f.name,f.symbol,f.formula,f.desc,f.cat].some(s=>s.toLowerCase().includes(q));
        return true;
      });
    }

    function renderList() {
      const visible = getVisible();
      $count.textContent = visible.length;
      $list.innerHTML = visible.map(f => `
        <div class="fl-item" data-id="${f.id}" style="padding:7px 12px;cursor:pointer;border-bottom:1px solid var(--border-tbl);
          background:${f.id===activeId?'#e3f2fd':'transparent'}">
          <div style="font-size:11px;font-weight:600;color:${f.id===activeId?'#1565C0':'var(--text)'};margin-bottom:1px">${f.name}</div>
          <div style="font-size:10px;color:var(--text-sec);font-family:monospace">${f.symbol}</div>
          <div style="font-size:10px;color:var(--text-sec)">${f.cat} ${bookmarks.has(f.id)?'★':''}</div>
        </div>`).join('');
    }

    function renderDetail(f) {
      const isBm = bookmarks.has(f.id);
      let inputHtml = f.inputs.map(inp =>
        `<div class="form-row" style="margin:3px 0">
          <label style="width:160px;font-size:11px">${inp.label}</label>
          <input type="number" id="fl-inp-${inp.id}" class="fl-input" data-fid="${f.id}"
            value="" step="any"
            style="width:90px;padding:3px 5px;border:1px solid var(--border);border-radius:3px;
            background:var(--bg-input);color:var(--text);font-size:11px">
          ${inp.unit ? `<span style="font-size:10px;color:var(--text-sec);margin-left:4px">${inp.unit}</span>` : ''}
        </div>`).join('');

      $detail.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
  <div>
    <div style="font-size:14px;font-weight:700;color:var(--text)">${f.name}</div>
    <div style="font-size:11px;color:var(--text-sec);margin-top:2px">${f.cat}</div>
  </div>
  <button id="fl-bm-btn" style="background:none;border:none;cursor:pointer;font-size:20px;color:${isBm?'#f9a825':'#ccc'}" title="${isBm?'Remove bookmark':'Bookmark'}">★</button>
</div>

<div style="background:#f3f8ff;border:1px solid #bbdefb;border-radius:6px;padding:10px 14px;margin-bottom:10px;font-family:monospace;font-size:13px;color:#1a237e">
  ${f.formula}
</div>

<p style="font-size:12px;color:var(--text);line-height:1.6;margin-bottom:8px">${f.desc}</p>
<p style="font-size:10px;color:var(--text-sec);margin-bottom:12px">Ref: ${f.ref}</p>

<div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:6px">QUICK SOLVER</div>
${inputHtml}
<div style="margin-top:8px;display:flex;gap:6px">
  <button class="btn-xs btn-blue" id="fl-solve-btn">&#9654; Solve</button>
  <button class="btn-xs" id="fl-copy-btn">&#128203; Copy formula</button>
</div>
<div id="fl-result" style="margin-top:8px;font-size:12px"></div>`;

      // Bookmark
      document.getElementById('fl-bm-btn').addEventListener('click', () => {
        if (bookmarks.has(f.id)) bookmarks.delete(f.id);
        else bookmarks.add(f.id);
        saveBookmarks();
        renderDetail(f);
        renderList();
      });

      // Solve
      document.getElementById('fl-solve-btn').addEventListener('click', () => {
        const vals = {};
        for (const inp of f.inputs) {
          const el = document.getElementById(`fl-inp-${inp.id}`);
          const v  = parseFloat(el ? el.value : '');
          if (el && el.value !== '' && !isNaN(v)) vals[inp.id] = v;
        }
        try {
          const result = f.solve(vals);
          const rows = Object.entries(result).map(([k,v],i) =>
            `<tr style="${i%2?'background:var(--bg-tbl-alt)':''}">
              <td style="padding:3px 8px;color:var(--text-sec)">${k}</td>
              <td style="padding:3px 8px;font-weight:700;color:#1565C0">${v}</td>
            </tr>`).join('');
          document.getElementById('fl-result').innerHTML =
            `<table style="border-collapse:collapse;width:100%;font-size:12px">${rows}</table>`;
        } catch(e) {
          document.getElementById('fl-result').innerHTML =
            `<p style="color:red;font-size:11px">⚠ Check inputs — ${e.message}</p>`;
        }
      });

      // Copy
      document.getElementById('fl-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(`${f.name}\n${f.formula}\n${f.desc}\nRef: ${f.ref}`).catch(()=>{});
      });

      // Enter to solve on any input
      $detail.querySelectorAll('.fl-input').forEach(inp => {
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') document.getElementById('fl-solve-btn').click();
        });
      });
    }

    $list.addEventListener('click', e => {
      const item = e.target.closest('[data-id]');
      if (!item) return;
      activeId = item.dataset.id;
      renderList();
      const f = FORMULAS.find(x => x.id === activeId);
      if (f) renderDetail(f);
    });

    $search.addEventListener('input', renderList);

    renderList();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return { FORMULAS, buildDialogHTML, wireDialog };
})();

window.FormulaLibrary = FormulaLibrary;
