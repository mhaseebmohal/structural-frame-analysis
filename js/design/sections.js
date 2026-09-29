// ══════════════════════════════════════════════════════════════════
//  sections.js  —  Structural Section Database & Property System
//  Units stored: A [cm²], I [cm⁴], Z [cm³], S [cm³],
//                J [cm⁴], Cw [cm⁶], dimensions [mm]
//  E [GPa], fy [MPa], rho [kN/m³]
// ══════════════════════════════════════════════════════════════════

const SectionDB = (() => {

  // ── Raw IPE sections (European Standard) ─────────────────────────
  // Fields: d,bf,tf,tw,r  | A,Ix,Iy,Zx,Zy,Sx,Sy,J,Cw,rx,ry [cm/cm²…]
  const IPE = [
    // IPE 80 and IPE 100 had the ELASTIC modulus sitting in the plastic (Zx)
    // slot, with Sx carrying a value that matches nothing: Sx read 17.2 and
    // 29.3 where Ix/(d/2) — the definition of Wel,y for a doubly symmetric
    // section — gives 20.0 and 34.2. The pair still looked plausible because
    // 20.0/17.2 = 1.16 is a believable shape factor, so the usual sanity checks
    // passed. Sx drives the Class 3/4 flexural capacity, so both sections were
    // being designed 14 % light.
    { name:'IPE 80',  d:80,  bf:46,  tf:5.2, tw:3.8, r:5,  A:7.64,  Ix:80.1,   Iy:8.49,   Zx:23.2,  Zy:6.00,  Sx:20.0,  Sy:3.69,  J:0.070, Cw:243,   rx:3.24, ry:1.05 },
    { name:'IPE 100', d:100, bf:55,  tf:5.7, tw:4.1, r:7,  A:10.3,  Ix:171,    Iy:15.9,   Zx:39.4,  Zy:10.2,  Sx:34.2,  Sy:5.79,  J:0.124, Cw:712,   rx:4.07, ry:1.24 },
    { name:'IPE 120', d:120, bf:64,  tf:6.3, tw:4.4, r:7,  A:13.2,  Ix:318,    Iy:27.7,   Zx:60.7,  Zy:15.2,  Sx:53.0,  Sy:8.65,  J:0.198, Cw:1950,  rx:4.90, ry:1.45 },
    { name:'IPE 140', d:140, bf:73,  tf:6.9, tw:4.7, r:7,  A:16.4,  Ix:541,    Iy:44.9,   Zx:88.3,  Zy:22.4,  Sx:77.3,  Sy:12.3,  J:0.288, Cw:4630,  rx:5.74, ry:1.65 },
    { name:'IPE 160', d:160, bf:82,  tf:7.4, tw:5.0, r:9,  A:20.1,  Ix:869,    Iy:68.3,   Zx:123,   Zy:30.4,  Sx:109,   Sy:16.7,  J:0.408, Cw:9410,  rx:6.58, ry:1.84 },
    { name:'IPE 180', d:180, bf:91,  tf:8.0, tw:5.3, r:9,  A:23.9,  Ix:1317,   Iy:100,    Zx:166,   Zy:40.0,  Sx:146,   Sy:22.0,  J:0.558, Cw:17600, rx:7.42, ry:2.05 },
    { name:'IPE 200', d:200, bf:100, tf:8.5, tw:5.6, r:12, A:28.5,  Ix:1943,   Iy:142,    Zx:221,   Zy:51.6,  Sx:194,   Sy:28.5,  J:0.700, Cw:30000, rx:8.26, ry:2.24 },
    { name:'IPE 220', d:220, bf:110, tf:9.2, tw:5.9, r:12, A:33.4,  Ix:2772,   Iy:205,    Zx:285,   Zy:67.1,  Sx:252,   Sy:37.3,  J:0.919, Cw:49600, rx:9.11, ry:2.48 },
    { name:'IPE 240', d:240, bf:120, tf:9.8, tw:6.2, r:15, A:39.1,  Ix:3892,   Iy:284,    Zx:367,   Zy:85.7,  Sx:324,   Sy:47.3,  J:1.13,  Cw:79100, rx:9.97, ry:2.69 },
    { name:'IPE 270', d:270, bf:135, tf:10.2,tw:6.6, r:15, A:45.9,  Ix:5790,   Iy:420,    Zx:484,   Zy:119,   Sx:429,   Sy:62.2,  J:1.46,  Cw:143000,rx:11.2, ry:3.02 },
    { name:'IPE 300', d:300, bf:150, tf:10.7,tw:7.1, r:15, A:53.8,  Ix:8356,   Iy:604,    Zx:628,   Zy:153,   Sx:557,   Sy:80.5,  J:2.04,  Cw:226000,rx:12.5, ry:3.35 },
    { name:'IPE 330', d:330, bf:160, tf:11.5,tw:7.5, r:18, A:62.6,  Ix:11770,  Iy:788,    Zx:804,   Zy:188,   Sx:713,   Sy:98.5,  J:2.81,  Cw:342000,rx:13.7, ry:3.55 },
    { name:'IPE 360', d:360, bf:170, tf:12.7,tw:8.0, r:18, A:72.7,  Ix:16270,  Iy:1044,   Zx:1019,  Zy:233,   Sx:904,   Sy:123,   J:3.71,  Cw:528000,rx:15.0, ry:3.79 },
    { name:'IPE 400', d:400, bf:180, tf:13.5,tw:8.6, r:21, A:84.5,  Ix:23130,  Iy:1318,   Zx:1307,  Zy:277,   Sx:1156,  Sy:146,   J:5.12,  Cw:826000,rx:16.5, ry:3.95 },
    { name:'IPE 450', d:450, bf:190, tf:14.6,tw:9.4, r:21, A:98.8,  Ix:33740,  Iy:1676,   Zx:1702,  Zy:335,   Sx:1500,  Sy:176,   J:7.43,  Cw:1.3e6, rx:18.5, ry:4.12 },
    { name:'IPE 500', d:500, bf:200, tf:16.0,tw:10.2,r:21, A:116,   Ix:48200,  Iy:2142,   Zx:2194,  Zy:405,   Sx:1928,  Sy:214,   J:11.0,  Cw:2.0e6, rx:20.4, ry:4.31 },
    { name:'IPE 550', d:550, bf:210, tf:17.2,tw:11.1,r:24, A:134,   Ix:67120,  Iy:2668,   Zx:2787,  Zy:482,   Sx:2441,  Sy:254,   J:15.2,  Cw:2.9e6, rx:22.3, ry:4.45 },
    { name:'IPE 600', d:600, bf:220, tf:19.0,tw:12.0,r:24, A:156,   Ix:92080,  Iy:3387,   Zx:3512,  Zy:584,   Sx:3069,  Sy:308,   J:23.8,  Cw:4.2e6, rx:24.3, ry:4.66 },
  ];

  // ── HEA (European Wide Flange - light) ───────────────────────────
  const HEA = [
    { name:'HEA 100', d:96,  bf:100, tf:8.0, tw:5.0, r:12, A:21.2,  Ix:349,    Iy:134,    Zx:83.0,  Zy:40.2,  Sx:72.8,  Sy:26.8,  J:0.473, Cw:9630,  rx:4.06, ry:2.51 },
    { name:'HEA 120', d:114, bf:120, tf:8.0, tw:5.0, r:12, A:25.3,  Ix:606,    Iy:231,    Zx:119,   Zy:57.8,  Sx:106,   Sy:38.5,  J:0.584, Cw:21200, rx:4.89, ry:3.02 },
    { name:'HEA 140', d:133, bf:140, tf:8.5, tw:5.5, r:12, A:31.4,  Ix:1033,   Iy:389,    Zx:173,   Zy:83.9,  Sx:155,   Sy:55.6,  J:0.893, Cw:44200, rx:5.73, ry:3.52 },
    { name:'HEA 160', d:152, bf:160, tf:9.0, tw:6.0, r:15, A:38.8,  Ix:1673,   Iy:616,    Zx:245,   Zy:117,   Sx:220,   Sy:77.0,  J:1.30,  Cw:86000, rx:6.57, ry:3.98 },
    { name:'HEA 180', d:171, bf:180, tf:9.5, tw:6.0, r:15, A:45.3,  Ix:2510,   Iy:924,    Zx:324,   Zy:156,   Sx:294,   Sy:103,   J:1.71,  Cw:152000,rx:7.45, ry:4.51 },
    { name:'HEA 200', d:190, bf:200, tf:10.0,tw:6.5, r:18, A:53.8,  Ix:3692,   Iy:1336,   Zx:429,   Zy:204,   Sx:389,   Sy:134,   J:2.49,  Cw:257000,rx:8.28, ry:4.98 },
    { name:'HEA 220', d:210, bf:220, tf:11.0,tw:7.0, r:18, A:64.3,  Ix:5410,   Iy:1955,   Zx:568,   Zy:271,   Sx:515,   Sy:178,   J:3.89,  Cw:435000,rx:9.17, ry:5.51 },
    { name:'HEA 240', d:230, bf:240, tf:12.0,tw:7.5, r:21, A:76.8,  Ix:7763,   Iy:2769,   Zx:744,   Zy:351,   Sx:675,   Sy:231,   J:5.84,  Cw:705000,rx:10.1, ry:6.00 },
    { name:'HEA 260', d:250, bf:260, tf:12.5,tw:7.5, r:24, A:86.8,  Ix:10450,  Iy:3668,   Zx:919,   Zy:431,   Sx:836,   Sy:282,   J:7.47,  Cw:1.04e6,rx:11.0, ry:6.50 },
    { name:'HEA 280', d:270, bf:280, tf:13.0,tw:8.0, r:24, A:97.3,  Ix:13670,  Iy:4763,   Zx:1112,  Zy:524,   Sx:1013,  Sy:340,   J:9.85,  Cw:1.45e6,rx:11.9, ry:6.99 },
    { name:'HEA 300', d:290, bf:300, tf:14.0,tw:8.5, r:27, A:113,   Ix:18260,  Iy:6310,   Zx:1383,  Zy:643,   Sx:1260,  Sy:421,   J:13.3,  Cw:2.09e6,rx:12.7, ry:7.49 },
    { name:'HEA 320', d:310, bf:300, tf:15.5,tw:9.0, r:27, A:124,   Ix:22930,  Iy:6985,   Zx:1628,  Zy:711,   Sx:1479,  Sy:466,   J:18.0,  Cw:2.59e6,rx:13.6, ry:7.51 },
    { name:'HEA 340', d:330, bf:300, tf:16.5,tw:9.5, r:27, A:133,   Ix:27690,  Iy:7436,   Zx:1850,  Zy:757,   Sx:1679,  Sy:496,   J:23.6,  Cw:3.06e6,rx:14.4, ry:7.47 },
    { name:'HEA 360', d:350, bf:300, tf:17.5,tw:10.0,r:27, A:143,   Ix:33090,  Iy:7887,   Zx:2088,  Zy:802,   Sx:1891,  Sy:526,   J:31.7,  Cw:3.58e6,rx:15.2, ry:7.43 },
    { name:'HEA 400', d:390, bf:300, tf:19.0,tw:11.0,r:27, A:159,   Ix:45070,  Iy:8564,   Zx:2562,  Zy:872,   Sx:2311,  Sy:571,   J:52.2,  Cw:4.65e6,rx:16.8, ry:7.34 },
  ];

  // ── HEB (European Wide Flange - heavy) ───────────────────────────
  const HEB = [
    { name:'HEB 100', d:100, bf:100, tf:10.0,tw:6.0, r:12, A:26.0,  Ix:449,    Iy:167,    Zx:104,   Zy:50.0,  Sx:89.9,  Sy:33.5,  J:0.899, Cw:11600, rx:4.16, ry:2.53 },
    { name:'HEB 120', d:120, bf:120, tf:11.0,tw:6.5, r:12, A:34.0,  Ix:864,    Iy:318,    Zx:165,   Zy:79.5,  Sx:144,   Sy:53.0,  J:1.69,  Cw:30700, rx:5.04, ry:3.06 },
    { name:'HEB 140', d:140, bf:140, tf:12.0,tw:7.0, r:12, A:43.0,  Ix:1509,   Iy:550,    Zx:245,   Zy:118,   Sx:216,   Sy:78.5,  J:2.73,  Cw:62900, rx:5.93, ry:3.58 },
    { name:'HEB 160', d:160, bf:160, tf:13.0,tw:8.0, r:15, A:54.3,  Ix:2492,   Iy:889,    Zx:354,   Zy:167,   Sx:311,   Sy:111,   J:4.51,  Cw:118000,rx:6.78, ry:4.05 },
    { name:'HEB 180', d:180, bf:180, tf:14.0,tw:8.5, r:15, A:65.3,  Ix:3831,   Iy:1363,   Zx:481,   Zy:229,   Sx:426,   Sy:152,   J:7.66,  Cw:202000,rx:7.66, ry:4.57 },
    { name:'HEB 200', d:200, bf:200, tf:15.0,tw:9.0, r:18, A:78.1,  Ix:5696,   Iy:2003,   Zx:642,   Zy:303,   Sx:570,   Sy:200,   J:11.6,  Cw:330000,rx:8.54, ry:5.07 },
    { name:'HEB 220', d:220, bf:220, tf:16.0,tw:9.5, r:18, A:91.0,  Ix:8091,   Iy:2843,   Zx:827,   Zy:390,   Sx:736,   Sy:259,   J:16.2,  Cw:521000,rx:9.43, ry:5.59 },
    { name:'HEB 240', d:240, bf:240, tf:17.0,tw:10.0,r:21, A:106,   Ix:11260,  Iy:3923,   Zx:1053,  Zy:493,   Sx:938,   Sy:327,   J:21.7,  Cw:779000,rx:10.3, ry:6.08 },
    { name:'HEB 260', d:260, bf:260, tf:17.5,tw:10.0,r:24, A:118,   Ix:14920,  Iy:5135,   Zx:1283,  Zy:602,   Sx:1148,  Sy:395,   J:28.3,  Cw:1.09e6,rx:11.2, ry:6.58 },
    { name:'HEB 280', d:280, bf:280, tf:18.0,tw:10.5,r:24, A:131,   Ix:19270,  Iy:6595,   Zx:1534,  Zy:718,   Sx:1376,  Sy:471,   J:37.4,  Cw:1.50e6,rx:12.1, ry:7.09 },
    { name:'HEB 300', d:300, bf:300, tf:19.0,tw:11.0,r:27, A:149,   Ix:25170,  Iy:8563,   Zx:1869,  Zy:870,   Sx:1678,  Sy:571,   J:52.2,  Cw:2.14e6,rx:13.0, ry:7.58 },
    { name:'HEB 320', d:320, bf:300, tf:20.5,tw:11.5,r:27, A:161,   Ix:30820,  Iy:9239,   Zx:2149,  Zy:939,   Sx:1926,  Sy:616,   J:68.8,  Cw:2.61e6,rx:13.8, ry:7.57 },
    { name:'HEB 340', d:340, bf:300, tf:21.5,tw:12.0,r:27, A:171,   Ix:36660,  Iy:9690,   Zx:2408,  Zy:985,   Sx:2156,  Sy:646,   J:88.5,  Cw:3.09e6,rx:14.6, ry:7.53 },
    { name:'HEB 360', d:360, bf:300, tf:22.5,tw:12.5,r:27, A:181,   Ix:43190,  Iy:10140,  Zx:2683,  Zy:1031,  Sx:2400,  Sy:676,   J:112,   Cw:3.61e6,rx:15.5, ry:7.49 },
    { name:'HEB 400', d:400, bf:300, tf:24.0,tw:13.5,r:27, A:198,   Ix:57680,  Iy:10820,  Zx:3232,  Zy:1104,  Sx:2884,  Sy:721,   J:161,   Cw:4.65e6,rx:17.1, ry:7.40 },
    { name:'HEB 450', d:450, bf:300, tf:26.0,tw:14.0,r:27, A:218,   Ix:79890,  Iy:11720,  Zx:3982,  Zy:1198,  Sx:3551,  Sy:781,   J:266,   Cw:6.27e6,rx:19.1, ry:7.33 },
    { name:'HEB 500', d:500, bf:300, tf:28.0,tw:14.5,r:27, A:239,   Ix:107200, Iy:12620,  Zx:4815,  Zy:1292,  Sx:4287,  Sy:841,   J:424,   Cw:8.17e6,rx:21.2, ry:7.27 },
    { name:'HEB 550', d:550, bf:300, tf:29.0,tw:15.0,r:27, A:254,   Ix:136700, Iy:13080,  Zx:5591,  Zy:1341,  Sx:4971,  Sy:872,   J:516,   Cw:1.01e7,rx:23.2, ry:7.17 },
    { name:'HEB 600', d:600, bf:300, tf:30.0,tw:15.5,r:27, A:270,   Ix:171000, Iy:13530,  Zx:6425,  Zy:1388,  Sx:5701,  Sy:902,   J:676,   Cw:1.21e7,rx:25.2, ry:7.08 },
  ];

  // ── CHS (Circular Hollow Section) ────────────────────────────────
  const CHS = [
    { name:'CHS 60.3×4',   d:60.3, bf:60.3, tf:4,   tw:4,   r:0, A:6.91, Ix:28.5,  Iy:28.5,  Zx:11.6, Zy:11.6, Sx:9.47, Sy:9.47, J:57.0, Cw:0, rx:2.03, ry:2.03 },
    { name:'CHS 76.1×5',   d:76.1, bf:76.1, tf:5,   tw:5,   r:0, A:11.1, Ix:73.9,  Iy:73.9,  Zx:23.8, Zy:23.8, Sx:19.4, Sy:19.4, J:148,  Cw:0, rx:2.58, ry:2.58 },
    { name:'CHS 88.9×5',   d:88.9, bf:88.9, tf:5,   tw:5,   r:0, A:13.1, Ix:120,   Iy:120,   Zx:33.2, Zy:33.2, Sx:26.9, Sy:26.9, J:240,  Cw:0, rx:3.03, ry:3.03 },
    { name:'CHS 101.6×5',  d:101.6,bf:101.6,tf:5,   tw:5,   r:0, A:15.1, Ix:181,   Iy:181,   Zx:43.8, Zy:43.8, Sx:35.6, Sy:35.6, J:362,  Cw:0, rx:3.47, ry:3.47 },
    { name:'CHS 114.3×6',  d:114.3,bf:114.3,tf:6,   tw:6,   r:0, A:20.4, Ix:314,   Iy:314,   Zx:67.4, Zy:67.4, Sx:54.9, Sy:54.9, J:628,  Cw:0, rx:3.92, ry:3.92 },
    { name:'CHS 139.7×6',  d:139.7,bf:139.7,tf:6,   tw:6,   r:0, A:25.2, Ix:582,   Iy:582,   Zx:102,  Zy:102,  Sx:83.4, Sy:83.4, J:1160, Cw:0, rx:4.81, ry:4.81 },
    { name:'CHS 168.3×8',  d:168.3,bf:168.3,tf:8,   tw:8,   r:0, A:40.7, Ix:1530,  Iy:1530,  Zx:222,  Zy:222,  Sx:182,  Sy:182,  J:3060, Cw:0, rx:6.13, ry:6.13 },
    { name:'CHS 219.1×10', d:219.1,bf:219.1,tf:10,  tw:10,  r:0, A:66.6, Ix:5258,  Iy:5258,  Zx:582,  Zy:582,  Sx:480,  Sy:480,  J:10520,Cw:0, rx:8.89, ry:8.89 },
    { name:'CHS 273×10',   d:273,  bf:273,  tf:10,  tw:10,  r:0, A:83.9, Ix:10350, Iy:10350, Zx:927,  Zy:927,  Sx:758,  Sy:758,  J:20700,Cw:0, rx:11.1, ry:11.1 },
  ];

  // ── SHS/RHS (Square/Rectangular Hollow Sections) ─────────────────
  const SHS = [
    { name:'SHS 50×4',   d:50,  bf:50,  tf:4,  tw:4,  r:4, A:7.19,  Ix:23.7,  Iy:23.7,  Zx:11.0, Zy:11.0, Sx:9.47, Sy:9.47, J:37.4, Cw:0, rx:1.82, ry:1.82 },
    { name:'SHS 60×4',   d:60,  bf:60,  tf:4,  tw:4,  r:4, A:8.79,  Ix:41.4,  Iy:41.4,  Zx:16.0, Zy:16.0, Sx:13.8, Sy:13.8, J:65.0, Cw:0, rx:2.17, ry:2.17 },
    { name:'SHS 80×5',   d:80,  bf:80,  tf:5,  tw:5,  r:5, A:14.4,  Ix:120,   Iy:120,   Zx:35.1, Zy:35.1, Sx:30.0, Sy:30.0, J:188,  Cw:0, rx:2.89, ry:2.89 },
    { name:'SHS 100×5',  d:100, bf:100, tf:5,  tw:5,  r:5, A:18.4,  Ix:243,   Iy:243,   Zx:56.9, Zy:56.9, Sx:48.6, Sy:48.6, J:383,  Cw:0, rx:3.63, ry:3.63 },
    { name:'SHS 120×6',  d:120, bf:120, tf:6,  tw:6,  r:6, A:26.4,  Ix:508,   Iy:508,   Zx:99.2, Zy:99.2, Sx:84.6, Sy:84.6, J:797,  Cw:0, rx:4.38, ry:4.38 },
    { name:'SHS 150×6',  d:150, bf:150, tf:6,  tw:6,  r:6, A:33.4,  Ix:1020,  Iy:1020,  Zx:160,  Zy:160,  Sx:136,  Sy:136,  J:1590, Cw:0, rx:5.53, ry:5.53 },
    { name:'SHS 200×8',  d:200, bf:200, tf:8,  tw:8,  r:8, A:59.0,  Ix:3200,  Iy:3200,  Zx:370,  Zy:370,  Sx:320,  Sy:320,  J:4970, Cw:0, rx:7.36, ry:7.36 },
    { name:'RHS 100×50×5', d:100,bf:50, tf:5,  tw:5,  r:5, A:13.4,  Ix:148,   Iy:47.4,  Zx:35.8, Zy:22.7, Sx:29.6, Sy:18.9, J:117,  Cw:0, rx:3.32, ry:1.88 },
    { name:'RHS 150×75×5', d:150,bf:75, tf:5,  tw:5,  r:5, A:21.4,  Ix:572,   Iy:155,   Zx:90.5, Zy:48.5, Sx:76.2, Sy:41.4, J:440,  Cw:0, rx:5.17, ry:2.69 },
    { name:'RHS 200×100×6',d:200,bf:100,tf:6,  tw:6,  r:6, A:34.4,  Ix:1710,  Iy:468,   Zx:201,  Zy:111,  Sx:171,  Sy:93.5, J:1420, Cw:0, rx:7.05, ry:3.69 },
    { name:'RHS 250×150×8',d:250,bf:150,tf:8,  tw:8,  r:8, A:60.0,  Ix:5420,  Iy:2050,  Zx:505,  Zy:318,  Sx:434,  Sy:274,  J:5270, Cw:0, rx:9.51, ry:5.84 },
  ];

  // ── UB (Universal Beams — British Standard BS4) ──────────────────
  // Fields: d,bf,tf,tw,r [mm] | A[cm²], Ix,Iy[cm⁴], Sx,Sy,Zx,Zy[cm³], J,Cw[cm⁴,cm⁶], rx,ry[cm]
  const UB = [
    { name:'UB 127×76×13',  d:127,  bf:76,  tf:7.6,  tw:4.0,  r:7.6,  A:16.5, Ix:473,   Iy:24.3,  Zx:84.2,  Zy:12.9,  Sx:74.6, Sy:6.39, J:2.85,  Cw:1560,   rx:5.35, ry:1.21 },
    { name:'UB 152×89×16',  d:152,  bf:89,  tf:7.7,  tw:4.5,  r:7.6,  A:20.3, Ix:834,   Iy:47.4,  Zx:123,   Zy:17.8,  Sx:109,  Sy:10.7, J:3.56,  Cw:3880,   rx:6.41, ry:1.53 },
    { name:'UB 178×102×19', d:178,  bf:102, tf:7.9,  tw:4.8,  r:7.6,  A:24.3, Ix:1356,  Iy:80.8,  Zx:171,   Zy:24.2,  Sx:153,  Sy:15.9, J:4.41,  Cw:9460,   rx:7.48, ry:1.82 },
    { name:'UB 203×102×23', d:203,  bf:102, tf:9.3,  tw:5.4,  r:7.6,  A:29.4, Ix:2105,  Iy:101,   Zx:234,   Zy:30.5,  Sx:207,  Sy:19.8, J:7.02,  Cw:18200,  rx:8.46, ry:1.85 },
    { name:'UB 203×133×25', d:203,  bf:133, tf:7.8,  tw:5.7,  r:7.6,  A:32.2, Ix:2340,  Iy:308,   Zx:258,   Zy:70.9,  Sx:231,  Sy:46.2, J:5.66,  Cw:30500,  rx:8.52, ry:3.10 },
    { name:'UB 203×133×30', d:207,  bf:134, tf:9.6,  tw:6.4,  r:7.6,  A:38.0, Ix:2896,  Iy:384,   Zx:313,   Zy:87.3,  Sx:280,  Sy:57.4, J:8.86,  Cw:39400,  rx:8.73, ry:3.18 },
    { name:'UB 254×102×22', d:254,  bf:102, tf:6.8,  tw:5.7,  r:7.6,  A:28.1, Ix:2841,  Iy:89.8,  Zx:259,   Zy:33.5,  Sx:224,  Sy:17.6, J:4.15,  Cw:27400,  rx:10.1, ry:1.79 },
    { name:'UB 254×102×25', d:257,  bf:102, tf:8.4,  tw:6.0,  r:7.6,  A:32.0, Ix:3415,  Iy:107,   Zx:306,   Zy:38.7,  Sx:266,  Sy:21  , J:6.36,  Cw:34200,  rx:10.3, ry:1.83 },
    { name:'UB 254×102×28', d:260,  bf:102, tf:10.0, tw:6.3,  r:7.6,  A:36.1, Ix:4005,  Iy:126,   Zx:353,   Zy:44.1,  Sx:308,  Sy:24.7, J:10.0,  Cw:41700,  rx:10.5, ry:1.87 },
    { name:'UB 254×146×31', d:251,  bf:146, tf:8.6,  tw:6.0,  r:7.6,  A:39.7, Ix:4413,  Iy:448,   Zx:393,   Zy:107,   Sx:351,  Sy:61.4, J:7.28,  Cw:87800,  rx:10.5, ry:3.36 },
    { name:'UB 254×146×37', d:256,  bf:146, tf:10.9, tw:6.3,  r:7.6,  A:47.2, Ix:5537,  Iy:571,   Zx:483,   Zy:136,   Sx:433,  Sy:78.2, J:13.7,  Cw:113000, rx:10.8, ry:3.48 },
    { name:'UB 254×146×43', d:260,  bf:147, tf:12.7, tw:7.2,  r:7.6,  A:54.8, Ix:6544,  Iy:677,   Zx:566,   Zy:161,   Sx:504,  Sy:92.1,  J:22.5,  Cw:137000, rx:10.9, ry:3.51 },
    { name:'UB 305×102×25', d:305,  bf:102, tf:7.0,  tw:5.8,  r:7.6,  A:31.8, Ix:4455,  Iy:116,   Zx:342,   Zy:40.9,  Sx:292,  Sy:22.7, J:4.77,  Cw:41000,  rx:11.8, ry:1.90 },
    { name:'UB 305×102×33', d:313,  bf:102, tf:10.8, tw:6.6,  r:7.6,  A:41.8, Ix:6501,  Iy:194,   Zx:481,   Zy:57.2,  Sx:416,  Sy:38  , J:14.0,  Cw:64300,  rx:12.5, ry:2.15 },
    { name:'UB 305×165×40', d:303,  bf:165, tf:10.2, tw:6.0,  r:8.9,  A:51.5, Ix:8503,  Iy:764,   Zx:623,   Zy:168,   Sx:560,  Sy:92.6,  J:12.0,  Cw:230000, rx:12.9, ry:3.86 },
    { name:'UB 305×165×46', d:307,  bf:166, tf:11.8, tw:6.7,  r:8.9,  A:58.9, Ix:9899,  Iy:896,   Zx:720,   Zy:196,   Sx:646,  Sy:108,  J:17.9,  Cw:273000, rx:12.9, ry:3.89 },
    { name:'UB 305×165×54', d:310,  bf:167, tf:13.7, tw:7.9,  r:8.9,  A:68.8, Ix:11700, Iy:1060,  Zx:843,   Zy:230,   Sx:754,  Sy:127,  J:29.2,  Cw:328000, rx:13.0, ry:3.92 },
    { name:'UB 356×127×33', d:349,  bf:125, tf:8.5,  tw:5.9,  r:10.2, A:42.1, Ix:8125,  Iy:193,   Zx:543,   Zy:57.3,  Sx:466,  Sy:30.9, J:7.89,  Cw:82200,  rx:13.9, ry:2.14 },
    { name:'UB 356×127×39', d:353,  bf:126, tf:10.7, tw:6.6,  r:10.2, A:49.4, Ix:10170, Iy:248,   Zx:659,   Zy:68.6,  Sx:576,  Sy:39.4, J:14.1,  Cw:106000, rx:14.3, ry:2.24 },
    { name:'UB 356×171×45', d:351,  bf:171, tf:9.7,  tw:7.0,  r:10.2, A:57.3, Ix:12070, Iy:811,   Zx:775,   Zy:169,   Sx:687,  Sy:94.9,  J:14.3,  Cw:311000, rx:14.5, ry:3.76 },
    { name:'UB 356×171×51', d:355,  bf:172, tf:11.5, tw:7.4,  r:10.2, A:64.9, Ix:14140, Iy:968,   Zx:896,   Zy:201,   Sx:796,  Sy:113,  J:22.4,  Cw:374000, rx:14.8, ry:3.86 },
    { name:'UB 356×171×57', d:358,  bf:172, tf:13.0, tw:8.1,  r:10.2, A:72.2, Ix:16040, Iy:1108,  Zx:1010,  Zy:230,   Sx:896,  Sy:129,  J:32.0,  Cw:434000, rx:14.9, ry:3.91 },
    { name:'UB 356×171×67', d:363,  bf:173, tf:15.7, tw:9.1,  r:10.2, A:85.3, Ix:19460, Iy:1363,  Zx:1211,  Zy:282,   Sx:1071, Sy:158,  J:57.1,  Cw:539000, rx:15.1, ry:4.00 },
    { name:'UB 406×140×39', d:397,  bf:142, tf:8.6,  tw:6.4,  r:10.2, A:49.7, Ix:12510, Iy:271,   Zx:718,   Zy:68.8,  Sx:629,  Sy:38.2, J:9.03,  Cw:148000, rx:15.9, ry:2.33 },
    { name:'UB 406×140×46', d:401,  bf:142, tf:11.2, tw:6.8,  r:10.2, A:58.8, Ix:15690, Iy:340,   Zx:888,   Zy:80.1,  Sx:782,  Sy:47.9, J:17.7,  Cw:190000, rx:16.3, ry:2.40 },
    { name:'UB 406×178×54', d:403,  bf:178, tf:10.9, tw:7.7,  r:10.2, A:68.4, Ix:18720, Iy:1021,  Zx:1055,  Zy:214,   Sx:929,  Sy:115,  J:24.9,  Cw:514000, rx:16.5, ry:3.86 },
    { name:'UB 406×178×60', d:406,  bf:178, tf:12.8, tw:7.9,  r:10.2, A:76.5, Ix:21600, Iy:1199,  Zx:1199,  Zy:249,   Sx:1063, Sy:135,  J:35.8,  Cw:604000, rx:16.8, ry:3.96 },
    { name:'UB 406×178×67', d:409,  bf:179, tf:14.3, tw:8.8,  r:10.2, A:85.5, Ix:24330, Iy:1365,  Zx:1346,  Zy:286,   Sx:1189, Sy:153,  J:50.8,  Cw:690000, rx:16.9, ry:4.00 },
    { name:'UB 406×178×74', d:413,  bf:180, tf:16.0, tw:9.5,  r:10.2, A:94.5, Ix:27310, Iy:1545,  Zx:1501,  Zy:319,   Sx:1323, Sy:172,  J:72.0,  Cw:789000, rx:17.0, ry:4.04 },
    { name:'UB 457×152×52', d:450,  bf:152, tf:10.9, tw:7.6,  r:10.2, A:66.6, Ix:21370, Iy:645,   Zx:1091,  Zy:155,   Sx:950,  Sy:84.9,  J:21.4,  Cw:497000, rx:17.9, ry:3.11 },
    { name:'UB 457×152×60', d:455,  bf:153, tf:13.3, tw:8.1,  r:10.2, A:76.2, Ix:25500, Iy:795,   Zx:1284,  Zy:186,   Sx:1120, Sy:104,  J:36.6,  Cw:612000, rx:18.3, ry:3.23 },
    { name:'UB 457×191×67', d:453,  bf:190, tf:12.7, tw:8.5,  r:10.2, A:85.5, Ix:29380, Iy:1452,  Zx:1471,  Zy:290,   Sx:1296, Sy:153,  J:37.4,  Cw:1.05e6, rx:18.5, ry:4.12 },
    { name:'UB 457×191×74', d:457,  bf:190, tf:14.5, tw:9.0,  r:10.2, A:94.7, Ix:33390, Iy:1671,  Zx:1653,  Zy:333,   Sx:1462, Sy:176,  J:55.7,  Cw:1.22e6, rx:18.8, ry:4.20 },
    { name:'UB 457×191×82', d:460,  bf:191, tf:16.0, tw:9.9,  r:10.2, A:104,  Ix:37050, Iy:1871,  Zx:1832,  Zy:373,   Sx:1611, Sy:196,  J:76.1,  Cw:1.38e6, rx:18.9, ry:4.24 },
    { name:'UB 457×191×98', d:467,  bf:193, tf:19.6, tw:11.4, r:10.2, A:125,  Ix:45730, Iy:2347,  Zx:2232,  Zy:471,   Sx:1958, Sy:243,  J:150,   Cw:1.77e6, rx:19.1, ry:4.33 },
    { name:'UB 533×210×82', d:528,  bf:209, tf:13.2, tw:9.6,  r:12.7, A:104,  Ix:47540, Iy:2007,  Zx:2060,  Zy:367,   Sx:1800, Sy:192,  J:51.4,  Cw:2.23e6, rx:21.3, ry:4.38 },
    { name:'UB 533×210×92', d:533,  bf:209, tf:15.6, tw:10.1, r:12.7, A:117,  Ix:55230, Iy:2389,  Zx:2360,  Zy:436,   Sx:2072, Sy:229,  J:76.5,  Cw:2.65e6, rx:21.7, ry:4.51 },
    { name:'UB 533×210×101',d:537,  bf:210, tf:17.4, tw:10.9, r:12.7, A:129,  Ix:61520, Iy:2693,  Zx:2612,  Zy:492,   Sx:2292, Sy:256,  J:106,   Cw:3.01e6, rx:21.9, ry:4.57 },
    { name:'UB 533×210×122',d:545,  bf:212, tf:21.3, tw:12.7, r:12.7, A:155,  Ix:76040, Iy:3388,  Zx:3196,  Zy:621,   Sx:2795, Sy:320,  J:193,   Cw:3.85e6, rx:22.2, ry:4.68 },
    { name:'UB 610×229×101',d:602,  bf:228, tf:14.8, tw:10.5, r:12.7, A:129,  Ix:75780, Iy:2916,  Zx:2880,  Zy:481,   Sx:2520, Sy:256,  J:68.3,  Cw:5.24e6, rx:24.2, ry:4.75 },
    { name:'UB 610×229×125',d:612,  bf:229, tf:19.6, tw:11.9, r:12.7, A:159,  Ix:98610, Iy:3932,  Zx:3677,  Zy:648,   Sx:3221, Sy:343,  J:148,   Cw:7.10e6, rx:24.9, ry:4.97 },
    { name:'UB 610×229×140',d:617,  bf:230, tf:22.1, tw:13.1, r:12.7, A:178,  Ix:112000,Iy:4509,  Zx:4142,  Zy:745,   Sx:3626, Sy:392,  J:217,   Cw:8.20e6, rx:25.1, ry:5.03 },
    { name:'UB 686×254×125',d:678,  bf:253, tf:16.2, tw:11.7, r:15.2, A:159,  Ix:118000,Iy:4383,  Zx:3994,  Zy:649,   Sx:3481, Sy:346,  J:106,   Cw:9.64e6, rx:27.2, ry:5.24 },
    { name:'UB 686×254×140',d:684,  bf:254, tf:19.0, tw:12.4, r:15.2, A:178,  Ix:136000,Iy:5183,  Zx:4558,  Zy:771,   Sx:3987, Sy:408,  J:168,   Cw:11.4e6, rx:27.6, ry:5.40 },
    { name:'UB 762×267×134',d:750,  bf:264, tf:15.5, tw:12.0, r:16.5, A:171,  Ix:150700,Iy:4788,  Zx:4644,  Zy:696,   Sx:4018, Sy:363,  J:119,   Cw:14.5e6, rx:29.7, ry:5.29 },
    { name:'UB 762×267×173',d:762,  bf:267, tf:21.6, tw:14.3, r:16.5, A:220,  Ix:205300,Iy:6850,  Zx:6198,  Zy:990,   Sx:5390, Sy:513,  J:286,   Cw:20.9e6, rx:30.5, ry:5.57 },
    { name:'UB 838×292×176',d:835,  bf:292, tf:18.8, tw:14.0, r:17.8, A:224,  Ix:246000,Iy:7799,  Zx:6808,  Zy:1002,  Sx:5893, Sy:534,  J:247,   Cw:34.4e6, rx:33.1, ry:5.90 },
    { name:'UB 914×305×201',d:903,  bf:303, tf:20.2, tw:15.2, r:19.1, A:256,  Ix:325300,Iy:9423,  Zx:8351,  Zy:1176,  Sx:7204, Sy:622,  J:327,   Cw:63.2e6, rx:35.7, ry:6.07 },
    { name:'UB 914×305×253',d:918,  bf:305, tf:27.1, tw:17.3, r:19.1, A:322,  Ix:436900,Iy:12570, Zx:11100, Zy:1573,  Sx:9535, Sy:824 , J:725,   Cw:87.5e6, rx:36.8, ry:6.25 },
  ];

  // ── UC (Universal Columns — British Standard BS4) ─────────────────
  const UC = [
    { name:'UC 152×152×23',  d:152, bf:152, tf:6.8,  tw:6.1,  r:7.6,  A:29.2, Ix:1263,  Iy:403,   Zx:182,   Zy:80.8,  Sx:166,  Sy:53.3, J:5.49,  Cw:13900,  rx:6.57, ry:3.71 },
    { name:'UC 152×152×30',  d:158, bf:153, tf:9.4,  tw:6.5,  r:7.6,  A:38.3, Ix:1742,  Iy:560,   Zx:248,   Zy:111,   Sx:221,  Sy:73.3, J:12.2,  Cw:19800,  rx:6.75, ry:3.82 },
    { name:'UC 152×152×37',  d:163, bf:154, tf:11.5, tw:8.0,  r:7.6,  A:47.1, Ix:2210,  Iy:706,   Zx:309,   Zy:140,   Sx:272,  Sy:91.5, J:22.2,  Cw:25800,  rx:6.85, ry:3.87 },
    { name:'UC 203×203×46',  d:203, bf:204, tf:11.0, tw:7.2,  r:10.2, A:58.8, Ix:4568,  Iy:1539,  Zx:497,   Zy:228,   Sx:450,  Sy:151,  J:22.2,  Cw:141000, rx:8.82, ry:5.11 },
    { name:'UC 203×203×52',  d:206, bf:204, tf:12.5, tw:7.9,  r:10.2, A:66.3, Ix:5263,  Iy:1778,  Zx:567,   Zy:263,   Sx:511,  Sy:174,  J:31.6,  Cw:165000, rx:8.91, ry:5.18 },
    { name:'UC 203×203×60',  d:210, bf:206, tf:14.2, tw:9.4,  r:10.2, A:76.4, Ix:6088,  Iy:2065,  Zx:656,   Zy:305,   Sx:581,  Sy:201,  J:47.2,  Cw:196000, rx:8.96, ry:5.20 },
    { name:'UC 203×203×71',  d:216, bf:206, tf:17.3, tw:10.0, r:10.2, A:90.6, Ix:7618,  Iy:2537,  Zx:799,   Zy:374,   Sx:706,  Sy:246,  J:82.7,  Cw:248000, rx:9.18, ry:5.30 },
    { name:'UC 203×203×86',  d:222, bf:209, tf:20.5, tw:12.7, r:10.2, A:110,  Ix:9449,  Iy:3127,  Zx:977,   Zy:458,   Sx:851,  Sy:299,  J:141,   Cw:315000, rx:9.28, ry:5.34 },
    { name:'UC 254×254×73',  d:254, bf:255, tf:14.2, tw:8.6,  r:12.7, A:93.1, Ix:11410, Iy:3908,  Zx:990,   Zy:461,   Sx:898,  Sy:307,  J:56.3,  Cw:562000, rx:11.1, ry:6.48 },
    { name:'UC 254×254×89',  d:260, bf:256, tf:17.3, tw:10.3, r:12.7, A:114,  Ix:14270, Iy:4857,  Zx:1224,  Zy:574,   Sx:1097, Sy:379,  J:101,   Cw:715000, rx:11.2, ry:6.55 },
    { name:'UC 254×254×107', d:267, bf:259, tf:20.5, tw:12.8, r:12.7, A:136,  Ix:17510, Iy:5928,  Zx:1484,  Zy:700,   Sx:1313, Sy:458,  J:172,   Cw:892000, rx:11.3, ry:6.59 },
    { name:'UC 254×254×132', d:276, bf:261, tf:25.3, tw:15.3, r:12.7, A:168,  Ix:22530, Iy:7531,  Zx:1869,  Zy:884,   Sx:1631, Sy:577,  J:326,   Cw:1.18e6, rx:11.6, ry:6.70 },
    { name:'UC 254×254×167', d:289, bf:265, tf:31.7, tw:19.2, r:12.7, A:212,  Ix:29970, Iy:9870,  Zx:2424,  Zy:1149,  Sx:2075, Sy:745,  J:651,   Cw:1.59e6, rx:11.9, ry:6.83 },
    { name:'UC 305×305×97',  d:308, bf:305, tf:15.4, tw:9.9,  r:15.2, A:123,  Ix:22250, Iy:7308,  Zx:1589,  Zy:722,   Sx:1445, Sy:481,  J:89.0,  Cw:1.57e6, rx:13.4, ry:7.69 },
    { name:'UC 305×305×118', d:315, bf:307, tf:18.7, tw:11.9, r:15.2, A:150,  Ix:27670, Iy:9059,  Zx:1960,  Zy:892,   Sx:1759, Sy:589,  J:161,   Cw:1.98e6, rx:13.6, ry:7.77 },
    { name:'UC 305×305×137', d:321, bf:309, tf:21.7, tw:13.8, r:15.2, A:174,  Ix:32810, Iy:10700, Zx:2297,  Zy:1047,  Sx:2048, Sy:692,  J:256,   Cw:2.40e6, rx:13.7, ry:7.84 },
    { name:'UC 305×305×158', d:327, bf:311, tf:25.0, tw:15.8, r:15.2, A:201,  Ix:38750, Iy:12570, Zx:2680,  Zy:1231,  Sx:2368, Sy:808,  J:394,   Cw:2.89e6, rx:13.9, ry:7.91 },
    { name:'UC 305×305×198', d:340, bf:315, tf:31.4, tw:19.1, r:15.2, A:252,  Ix:50110, Iy:16270, Zx:3440,  Zy:1601,  Sx:2949, Sy:1040, J:791,   Cw:3.83e6, rx:14.1, ry:8.02 },
    { name:'UC 305×305×240', d:353, bf:318, tf:37.7, tw:23.6, r:15.2, A:306,  Ix:64200, Iy:20310, Zx:4254,  Zy:1977,  Sx:3640, Sy:1280, J:1408,  Cw:4.96e6, rx:14.5, ry:8.15 },
    { name:'UC 356×368×129', d:356, bf:369, tf:17.5, tw:10.4, r:15.2, A:164,  Ix:40290, Iy:14610, Zx:2484,  Zy:1188,  Sx:2268, Sy:793,  J:143,   Cw:4.80e6, rx:15.7, ry:9.44 },
    { name:'UC 356×368×153', d:362, bf:371, tf:20.7, tw:12.3, r:15.2, A:195,  Ix:48590, Iy:17550, Zx:2963,  Zy:1425,  Sx:2685, Sy:948,  J:238,   Cw:5.87e6, rx:15.8, ry:9.50 },
    { name:'UC 356×368×177', d:368, bf:373, tf:23.8, tw:14.4, r:15.2, A:226,  Ix:57130, Iy:20530, Zx:3457,  Zy:1659,  Sx:3104, Sy:1104, J:373,   Cw:6.95e6, rx:15.9, ry:9.55 },
    { name:'UC 356×368×202', d:375, bf:375, tf:27.0, tw:16.5, r:15.2, A:257,  Ix:66260, Iy:23630, Zx:3972,  Zy:1908,  Sx:3540, Sy:1266, J:554,   Cw:8.14e6, rx:16.1, ry:9.60 },
    { name:'UC 356×406×235', d:381, bf:395, tf:30.2, tw:18.4, r:15.2, A:299,  Ix:79080, Iy:31010, Zx:4693,  Zy:2383,  Sx:4151, Sy:1570, J:812,   Cw:11.4e6, rx:16.3, ry:10.2 },
    { name:'UC 356×406×287', d:394, bf:399, tf:36.5, tw:22.6, r:15.2, A:366,  Ix:99880, Iy:38680, Zx:5812,  Zy:2965,  Sx:5075, Sy:1939, J:1436,  Cw:14.6e6, rx:16.5, ry:10.3 },
    { name:'UC 356×406×340', d:406, bf:403, tf:42.9, tw:26.6, r:15.2, A:433,  Ix:122200,Iy:46850, Zx:6999,  Zy:3572,  Sx:6031, Sy:2325, J:2397,  Cw:18.0e6, rx:16.8, ry:10.4 },
    { name:'UC 356×406×393', d:419, bf:407, tf:49.2, tw:30.6, r:15.2, A:500,  Ix:146600,Iy:55370, Zx:8243,  Zy:4197,  Sx:6994, Sy:2720, J:3624,  Cw:22.0e6, rx:17.1, ry:10.5 },
  ];

  // ── Concrete Sections (rectangular RC, Tee, Circular) ────────────
  // These are plain rectangles and circles, so every property is exact.
  // Two different errors were present, and A/Ix/rx being right on the
  // rectangles is why neither showed up:
  //   • the RECTANGLES had Sx, Sy, Zx and Zy ten times too small — RC 300×600
  //     listed Sx = 1800 cm³ where Ix/(h/2) gives 18 000. Sx is the elastic
  //     modulus the Class 3/4 steel path reads, and Zx the plastic one.
  //   • the CIRCLES had the opposite: Ix and Iy ten times too LARGE (Ø300 held
  //     397 608 cm⁴ against πD⁴/64 = 39 761), which also dragged rx to 23.7 cm
  //     where a Ø300 circle has D/4 = 7.5. Ix drives the analysis, so a circular
  //     column came out ten times too stiff.
  // Zx/Zy are the true plastic moduli (b·h²/4 for a rectangle, D³/6 for a
  // circle) rather than 1.2 × elastic, and J is the St Venant constant.
  const RC = [
    { name:'RC 200×400', d:400, bf:200, tf:200, tw:200, r:0, A:800,  Ix:106667, Iy:26667,  Zx:8000,  Zy:4000,  Sx:5333,  Sy:2667,  J:73280,   Cw:0, rx:11.5, ry:5.77, material:'concrete' },
    { name:'RC 250×500', d:500, bf:250, tf:250, tw:250, r:0, A:1250, Ix:260417, Iy:65104,  Zx:15625, Zy:7813,  Sx:10417, Sy:5208,  J:178906,  Cw:0, rx:14.4, ry:7.22, material:'concrete' },
    { name:'RC 300×600', d:600, bf:300, tf:300, tw:300, r:0, A:1800, Ix:540000, Iy:135000, Zx:27000, Zy:13500, Sx:18000, Sy:9000,  J:370980,  Cw:0, rx:17.3, ry:8.66, material:'concrete' },
    { name:'RC 400×600', d:600, bf:400, tf:400, tw:400, r:0, A:2400, Ix:720000, Iy:320000, Zx:36000, Zy:24000, Sx:24000, Sy:16000, J:752640,  Cw:0, rx:17.3, ry:11.5, material:'concrete' },
    { name:'RC 400×800', d:800, bf:400, tf:400, tw:400, r:0, A:3200, Ix:1706667,Iy:426667, Zx:64000, Zy:32000, Sx:42667, Sy:21333, J:1172480, Cw:0, rx:23.1, ry:11.5, material:'concrete' },
    { name:'RC 500×1000',d:1000,bf:500, tf:500, tw:500, r:0, A:5000, Ix:4166667,Iy:1041667,Zx:125000,Zy:62500, Sx:83333, Sy:41667, J:2862500, Cw:0, rx:28.9, ry:14.4, material:'concrete' },
    { name:'Circ Ø300', d:300, bf:300, tf:150, tw:150, r:0, A:707,  Ix:39761,  Iy:39761,  Zx:4500,  Zy:4500,  Sx:2651,  Sy:2651,  J:79522,   Cw:0, rx:7.5,  ry:7.5,  material:'concrete' },
    { name:'Circ Ø500', d:500, bf:500, tf:250, tw:250, r:0, A:1963, Ix:306796, Iy:306796, Zx:20833, Zy:20833, Sx:12272, Sy:12272, J:613592,  Cw:0, rx:12.5, ry:12.5, material:'concrete' },
  ];

  // ── ACI 318-19 RC Sections (f'c = 28 MPa / 4000 psi, Ec ≈ 24.9 GPa, Grade 60 rebar fy = 420 MPa) ──
  // Properties calculated from gross section geometry per ACI 318-19 §6.6
  // Naming: ACI B = Beam, ACI C = Column | sizes in imperial (metric equivalent in brackets)
  const ACI_RC = [
    // ── Rectangular Beams ──────────────────────────────────────────────
    { name:'ACI B 10"×18" (254×457)', d:457, bf:254, tf:254, tw:254, r:0, A:1161, Ix:201900, Iy:62400,  Zx:13260, Zy:7370,  Sx:8840,  Sy:4910,  J:74900,   Cw:0, rx:13.2, ry:7.33, material:'concrete' },
    { name:'ACI B 12"×20" (305×508)', d:508, bf:305, tf:305, tw:305, r:0, A:1549, Ix:333200, Iy:120100, Zx:19680, Zy:11800, Sx:13110, Sy:7870,  J:144000,  Cw:0, rx:14.7, ry:8.81, material:'concrete' },
    { name:'ACI B 12"×24" (305×610)', d:610, bf:305, tf:305, tw:305, r:0, A:1861, Ix:576900, Iy:144200, Zx:28390, Zy:14180, Sx:18910, Sy:9450,  J:173000,  Cw:0, rx:17.6, ry:8.81, material:'concrete' },
    { name:'ACI B 14"×24" (356×610)', d:610, bf:356, tf:356, tw:356, r:0, A:2172, Ix:673400, Iy:229400, Zx:33110, Zy:19320, Sx:22070, Sy:12880, J:275000,  Cw:0, rx:17.6, ry:10.3, material:'concrete' },
    { name:'ACI B 16"×28" (406×711)', d:711, bf:406, tf:406, tw:406, r:0, A:2886, Ix:1217000, Iy:394000, Zx:51320, Zy:28700, Sx:34230, Sy:19420, J:504000,  Cw:0, rx:20.5, ry:11.7, material:'concrete' },
    { name:'ACI B 18"×30" (457×762)', d:762, bf:457, tf:457, tw:457, r:0, A:3482, Ix:1685000, Iy:606000, Zx:66300, Zy:39800, Sx:44200, Sy:26500, J:727000,  Cw:0, rx:22.0, ry:13.2, material:'concrete' },
    { name:'ACI B 20"×36" (508×914)', d:914, bf:508, tf:508, tw:508, r:0, A:4643, Ix:3232000, Iy:998000, Zx:106000,Zy:59000, Sx:70800, Sy:39300, J:1198000, Cw:0, rx:26.4, ry:14.7, material:'concrete' },
    { name:'ACI B 24"×42" (610×1067)',d:1067,bf:610, tf:610, tw:610, r:0, A:6509, Ix:6170000, Iy:2018000,Zx:173600,Zy:92500, Sx:115700,Sy:66200, J:2482000, Cw:0, rx:30.8, ry:17.6, material:'concrete' },
    // ── Square Columns ─────────────────────────────────────────────────
    { name:'ACI C 12"×12" (305×305)', d:305, bf:305, tf:305, tw:305, r:0, A:930,  Ix:72100,  Iy:72100,  Zx:7093,  Zy:7093,  Sx:4729,  Sy:4729,  J:122000,  Cw:0, rx:8.81, ry:8.81, material:'concrete' },
    { name:'ACI C 14"×14" (356×356)', d:356, bf:356, tf:356, tw:356, r:0, A:1267, Ix:133800,  Iy:133800, Zx:11280, Zy:11280, Sx:7520,  Sy:7520,  J:226000,  Cw:0, rx:10.3, ry:10.3, material:'concrete' },
    { name:'ACI C 16"×16" (406×406)', d:406, bf:406, tf:406, tw:406, r:0, A:1648, Ix:226400,  Iy:226400, Zx:16730, Zy:16730, Sx:11150, Sy:11150, J:383000,  Cw:0, rx:11.7, ry:11.7, material:'concrete' },
    { name:'ACI C 18"×18" (457×457)', d:457, bf:457, tf:457, tw:457, r:0, A:2088, Ix:363500,  Iy:363500, Zx:23860, Zy:23860, Sx:15910, Sy:15910, J:615000,  Cw:0, rx:13.2, ry:13.2, material:'concrete' },
    { name:'ACI C 20"×20" (508×508)', d:508, bf:508, tf:508, tw:508, r:0, A:2581, Ix:555000,  Iy:555000, Zx:32770, Zy:32770, Sx:21850, Sy:21850, J:939000,  Cw:0, rx:14.7, ry:14.7, material:'concrete' },
    { name:'ACI C 24"×24" (610×610)', d:610, bf:610, tf:610, tw:610, r:0, A:3721, Ix:1153800, Iy:1153800,Zx:56740, Zy:56740, Sx:37830, Sy:37830, J:1952000, Cw:0, rx:17.6, ry:17.6, material:'concrete' },
  ];

  // ── Timber Glulam Sections ────────────────────────────────────────
  // A glulam section is a plain rectangle, so every property here is exact:
  //   A = b·h   Ix = b·h³/12   Sx = b·h²/6   Zx = b·h²/4   rx = h/√12
  //
  // Three separate errors had crept in, all of which the A/Sx/Sy columns
  // survived intact so nothing looked obviously wrong:
  //   • Ix and Iy were TEN TIMES too large — GL 200×400 carried 1 066 667 cm⁴
  //     where the rectangle gives 106 667. Ix drives the whole analysis, so a
  //     glulam member came out ten times too stiff: deflections a tenth of the
  //     truth, and in a mixed frame the force distribution simply wrong.
  //   • rx and ry were also ten times too large — stored in mm while every
  //     other group in this file stores them in cm.
  //   • Zx and Zy were 1.2 × the elastic modulus. A rectangle's shape factor is
  //     exactly 1.5, so the plastic moduli were 20 % light.
  // J is the St Venant constant β·h·b³ with β = 0.229 for h/b = 2 (all four are
  // 1:2); it had been overstated roughly sevenfold.
  const GL = [
    { name:'GL 120×240', d:240, bf:120, tf:120, tw:120, r:0, A:288,  Ix:13824,  Iy:3456,  Zx:1728, Zy:864,  Sx:1152, Sy:576,  J:9497,   Cw:0, rx:6.93, ry:3.46, material:'timber' },
    { name:'GL 160×320', d:320, bf:160, tf:160, tw:160, r:0, A:512,  Ix:43691,  Iy:10923, Zx:4096, Zy:2048, Sx:2731, Sy:1365, J:30015,  Cw:0, rx:9.24, ry:4.62, material:'timber' },
    { name:'GL 200×400', d:400, bf:200, tf:200, tw:200, r:0, A:800,  Ix:106667, Iy:26667, Zx:8000, Zy:4000, Sx:5333, Sy:2667, J:73280,  Cw:0, rx:11.55,ry:5.77, material:'timber' },
    { name:'GL 240×480', d:480, bf:240, tf:240, tw:240, r:0, A:1152, Ix:221184, Iy:55296, Zx:13824,Zy:6912, Sx:9216, Sy:4608, J:151953, Cw:0, rx:13.86,ry:6.93, material:'timber' },
  ];

  // ── Build lookup map ──────────────────────────────────────────────
  const ALL = [...IPE, ...HEA, ...HEB, ...CHS, ...SHS, ...UB, ...UC, ...RC, ...ACI_RC, ...GL];
  const _map = {};
  ALL.forEach(s => { _map[s.name] = s; });

  // ── Property modifier defaults ────────────────────────────────────
  // Based on ETABS/ACI/EC2 stiffness reduction factors
  const DEFAULT_MODIFIERS = {
    f11: 1.0,   // axial (EA)
    f22: 1.0,   // shear about Y-Y (GA_y)
    f33: 1.0,   // shear about Z-Z (GA_z)
    fm:  1.0,   // torsion (GJ)
    fi2: 1.0,   // bending about Y-Y (EI_y)
    fi3: 1.0,   // bending about Z-Z (EI_z, strong axis)
    fmass: 1.0, // mass
    fwgt:  1.0, // weight
  };

  // Preset modifier sets live in PropertyModifiers.PRESETS (js/design/modifiers.js),
  // which is what the UI and the solver actually read. This used to be a
  // hand-maintained second copy and all six shared presets had drifted apart
  // from it (torsion fm 0.1 vs 1.0, and four of eight factors on RC Wall).
  // It is now derived, so the two cannot diverge again. Lazily read, because
  // sections.js loads before modifiers.js.
  function _modifierPresets() {
    const P = (typeof window !== 'undefined' && window.PropertyModifiers
               && window.PropertyModifiers.PRESETS) || null;
    if (!P) return {};
    const out = {};
    for (const k of Object.keys(P)) out[P[k].name || k] = P[k].values;
    return out;
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    all: ALL,
    map: _map,
    groups: { IPE, HEA, HEB, CHS, SHS, UB, UC, RC, ACI_RC, GL },
    get modifierPresets() { return _modifierPresets(); },
    defaultModifiers: DEFAULT_MODIFIERS,

    /** Find full section data by name (partial match OK) */
    find(name) {
      if (!name) return null;
      if (_map[name]) return _map[name];
      // Partial match
      const n = name.toLowerCase();
      return ALL.find(s => s.name.toLowerCase().includes(n)) || null;
    },

    /** Apply property modifiers to solver section object.
     *  Returns modified copies of E*A and E*I for the solver. */
    applyModifiers(sec, mods) {
      if (!mods) return sec;
      return {
        ...sec,
        // ?? not || throughout: a modifier of exactly 0 means "no stiffness",
        // and || read it as unset and handed back the unmodified property.
        _A_mod:  sec.A  * (mods.f11  ?? 1),
        _I_mod:  sec.I  * (mods.fi3  ?? 1),   // strong-axis I
        _Iy_mod: (sec.Iy || sec.I)  * (mods.fi2 ?? 1),
        _J_mod:  (sec.J  || 0) * (mods.fm   ?? 1),
        _modifiers: { ...mods }
      };
    },

    /** Get section type tag */
    type(sec) {
      if (!sec) return 'generic';
      if (sec.material === 'concrete') return 'concrete';
      if (sec.material === 'timber')   return 'timber';
      if (sec.name && sec.name.startsWith('CHS')) return 'chs';
      if (sec.name && (sec.name.startsWith('SHS') || sec.name.startsWith('RHS'))) return 'hss';
      if (sec.tf && sec.tw && sec.d && sec.bf) return 'I';
      return 'generic';
    },

    /** Compute shear area for an I-section */
    /** Shear area Av about the strong axis, EC3 §6.2.6(3), in cm².
     *
     *  The conversions were a hundredfold out: Av_mm2 * 1e-4 turns mm² into m²,
     *  not cm², and the web floor used 1e-6 (also m²). checks.js calls this and
     *  then multiplies by 1e-4 to go "cm² → m²", so Av reached Vpl,Rd a hundred
     *  times too small and every EC3 shear utilisation came out a hundred times
     *  too high. An IPE 300 has Av = 25.7 cm²; this returned 0.257.
     *
     *  It went unseen because checks.js has an inline fallback for when
     *  SectionDB is absent, and that fallback is correct — so the regression
     *  suite, which did not load this file, exercised the right code while the
     *  browser (where SectionDB always exists) used the wrong one.
     */
    shearAreaY(sec) {
      if (!sec.d || !sec.bf || !sec.tf || !sec.tw) return (sec.A || 0) * 0.5;   // cm²
      const r = sec.r || 0;
      // EC3: Av = A − 2·bf·tf + (tw + 2r)·tf, worked in mm² then taken to cm².
      const Av_mm2 = sec.A * 100 - 2 * sec.bf * sec.tf + (sec.tw + 2 * r) * sec.tf;
      const web_mm2 = sec.tw * (sec.d - 2 * sec.tf);      // η·hw·tw with η = 1.0
      return Math.max(Av_mm2, web_mm2) / 100;             // mm² → cm²
    },

    /** Build options list grouped by series */
    buildSelectOptions(includeCustom = true) {
      const groups = [
        { label:'Steel IPE (European)',  items: IPE },
        { label:'Steel HEA (European)',  items: HEA },
        { label:'Steel HEB (European)',  items: HEB },
        { label:'Steel UB (British)',     items: UB },
        { label:'Steel UC (British)',     items: UC },
        { label:'Steel CHS',             items: CHS },
        { label:'Steel SHS/RHS',         items: SHS },
        { label:'Concrete RC (EC2)',      items: RC },
        { label:'Concrete RC (ACI 318-19)', items: ACI_RC },
        { label:'Timber GL',             items: GL },
      ];
      return groups;
    }
  };
})();

// Make globally available
window.SectionDB = SectionDB;
