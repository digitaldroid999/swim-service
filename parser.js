// Crew Assist SWIM Service — TFMData XML Parser (v3)
// Built from real FAA message inspection.
//
// FAA TFMData XML structure:
//   <fltdOutput>
//     <fdm:fltdMessage acid="UAL440" depArpt="KEWR" arrArpt="KLAX" msgType="trackInformation" ...>
//       <fdm:trackInformation>
//         <nxcm:qualifiedAircraftId ...>
//           <nxce:igtd>2026-04-05T19:22:00Z</nxce:igtd>   <- IGTD = scheduled departure
//           ...
//         </nxcm:qualifiedAircraftId>
//         <nxcm:eta etaType="ESTIMATED" timeValue="2026-04-05T21:53:02Z"/>  <- ETA
//         <nxcm:speed>298</nxcm:speed>
//         <nxce:simpleAltitude>280</nxce:simpleAltitude>
//         <nxce:latitudeDMS degrees="33" direction="NORTH" minutes="51" seconds="02"/>
//         <nxce:longitudeDMS degrees="084" direction="WEST" minutes="35" seconds="00"/>
//       </fdm:trackInformation>
//     </fdm:fltdMessage>
//   </fltdOutput>

// ── ICAO airline (3-letter) → IATA (2-letter) ────────────────────────────────
const AIRLINE = {
  // US Majors
  UAL:'UA', AAL:'AA', DAL:'DL', SWA:'WN', ASA:'AS', JBU:'B6',
  FFT:'F9', NKS:'NK', HAL:'HA', SUN:'SY', VRD:'VX',
  // US Regionals / Express
  SKW:'OO', ENY:'9E', AWI:'ZW', RPA:'YX', PDT:'OE', QXE:'QX',
  MES:'YV', CPZ:'C5', GJS:'G7', EGF:'AA', FLG:'AA', SQA:'UA',
  UAX:'UA', TSC:'UA', CHQ:'WN', TRS:'WN', SWQ:'WN', SPR:'NK',
  // US Cargo / Charter
  GTI:'GT', FDX:'FX', UPS:'5X', ABX:'GB', ATN:'8C', NCB:'N8',
  // Canada
  ACA:'AC', WJA:'WS', TCA:'TS', JZA:'QK',
  // Mexico
  AMX:'AM', VIV:'Y4', TAI:'TA',
  // Central America / Caribbean
  BWA:'BW', CMP:'CM', LRC:'LR', TAB:'TA', HAV:'CU',
  // South America
  AVA:'AV', TAM:'JJ', LAN:'LA', GLO:'G3', AZU:'AD',
  ARG:'AR', LAT:'LA', PUA:'PU', AEA:'A6',
  // Europe
  BAW:'BA', VIR:'VS', KLM:'KL', AFR:'AF', DLH:'LH',
  SWR:'LX', AUA:'OS', IBE:'IB', EIN:'EI', AZA:'AZ',
  TAP:'TP', FIN:'AY', SAS:'SK', NAX:'DY', VLG:'VY',
  EZY:'U2', RYR:'FR', TUI:'X3', CTN:'OU', CSA:'OK',
  LOT:'LO', MAL:'MP', WZZ:'W6', BEL:'SN', VKG:'DY',
  // Middle East
  UAE:'EK', ETD:'EY', QTR:'QR', THY:'TK', ELY:'LY',
  RJA:'RJ', GFA:'GF', OMA:'WY', KAC:'KU', MSR:'MS',
  SVA:'SV', MEA:'ME', IAW:'IA',
  // Africa
  ETH:'ET', KQA:'KQ', SAA:'SA', CAW:'WB', RWD:'WB',
  // Asia
  ANA:'NH', JAL:'JL', SIA:'SQ', MAS:'MH', THA:'TG',
  VNA:'VN', PAL:'PR', CPA:'CX', CSN:'CZ', CCA:'CA',
  CES:'MU', KAL:'KE', AAR:'OZ', AIC:'AI', TGW:'VZ',
  // Australia / Pacific
  QFA:'QF', ANZ:'NZ', VAU:'VA',
};

// ── ICAO airport (4-letter) → IATA (3-letter) ────────────────────────────────
// Note: US airports starting with K are handled automatically (KEWR → EWR).
// This table covers non-K airports: Hawaii (PH*), Alaska (PA*), territories,
// Canada (CY*), Mexico (MM*), Caribbean, Central/South America, and international.
const APT = {

  // ── Hawaii ──────────────────────────────────────────────────────────────────
  PHNL:'HNL', PHOG:'OGG', PHKO:'KOA', PHLI:'LIH', PHJH:'JHM',
  PHNY:'LNY', PHTO:'ITO', PHMO:'MKK',

  // ── Alaska ──────────────────────────────────────────────────────────────────
  PANC:'ANC', PAFA:'FAI', PAJN:'JNU', PAKN:'AKN', PAOM:'OME',
  PABR:'BRW', PABT:'BTI', PACD:'CDB', PADQ:'ADQ', PAEN:'ENA',
  PAOT:'OTZ', PASN:'SNP', PAWG:'WRG', PAYA:'YAK', PADK:'ADK',
  PFYU:'FYU', PANN:'ENN', PAMC:'MRI', PAED:'EDF', PAEI:'EIL',

  // ── US Territories ──────────────────────────────────────────────────────────
  TJSJ:'SJU', TJBQ:'BQN', TJPS:'PSE', TJIG:'NRR',       // Puerto Rico
  TIST:'STT', TISX:'STX',                                  // US Virgin Islands
  PGUM:'GUM', PGSN:'SPN', PTRO:'ROR',                     // Guam, Saipan, Palau

  // ── Canada ──────────────────────────────────────────────────────────────────
  CYVR:'YVR', CYYZ:'YYZ', CYUL:'YUL', CYYC:'YYC', CYOW:'YOW',
  CYEG:'YEG', CYHZ:'YHZ', CYWG:'YWG', CYQR:'YQR', CYYJ:'YYJ',
  CYLW:'YLW', CYXE:'YXE', CYQB:'YQB', CYHM:'YHM', CYYT:'YYT',
  CYFC:'YFC', CYQX:'YQX', CYQM:'YQM', CYSJ:'YSJ', CYDF:'YDF',
  CYYB:'YYB', CYSB:'YSB', CYKF:'YKF', CYXU:'YXU', CYQG:'YQG',
  CYAM:'YAM', CYSH:'YSH', CYWH:'YWH', CYMX:'YMX', CYTZ:'YTZ',
  CYYF:'YYF', CYQQ:'YQQ', CYXX:'YXX', CYVP:'YVP',

  // ── Mexico ──────────────────────────────────────────────────────────────────
  MMUN:'CUN', MMGL:'GDL', MMMX:'MEX', MMTY:'MTY', MMTJ:'TIJ',
  MMAA:'ACA', MMZH:'ZIH', MMPR:'PVR', MMLO:'BJX', MMSD:'SJD',
  MMCU:'CUU', MMMZ:'MZT', MMZO:'ZLO', MMBT:'HUX', MMOX:'OAX',
  MMVR:'VER', MMTM:'TAM', MMSA:'SLP', MMCL:'CUL', MMTC:'TRC',
  MMQT:'QRO', MMCG:'CJS', MMHO:'HMO', MMPE:'PBC', MMMD:'MID',
  MMAS:'AGU', MMLC:'LZC', MMIO:'SLW', MMPN:'UPN', MMZC:'ZCL',
  MMTG:'TGZ', MMVA:'VSA', MMLP:'LTO', MMCE:'CTM', MMSL:'LMM',
  MMCP:'CPE', MMCB:'CVJ', MMSP:'MXL', MMVH:'MID',

  // ── Caribbean ───────────────────────────────────────────────────────────────
  // Bahamas
  MYGF:'FPO', MYNN:'NAS', MYEG:'GGT', MYIG:'IGA', MYBS:'TBI',
  MYES:'ELH', MYAM:'ASD', MYAT:'TBI', MYBC:'CCZ',
  // Jamaica
  MKJP:'KIN', MKJS:'MBJ',
  // Cuba
  MUHA:'HAV', MUVR:'VRA', MUSC:'SCU', MUCF:'CFG', MUMZ:'MZO',
  // Dominican Republic
  MDSD:'SDQ', MDPC:'PUJ', MDST:'STI', MDPP:'POP',
  // Puerto Rico (above), Virgin Islands (above)
  // Aruba / Curacao / Bonaire
  TNCA:'AUA', TNCB:'BON', TNCC:'CUR',
  // Sint Maarten / St Martin
  TNCM:'SXM',
  // Guadeloupe / Martinique / St Barts
  TFFR:'PTP', TFFF:'FDF', TFFJ:'SBH',
  // Turks & Caicos
  MBGT:'GDT', MBPV:'PLS',
  // Cayman Islands
  MWCR:'GCM', MWCB:'CYB',
  // Bermuda
  TXKF:'BDA',
  // Haiti
  MTPP:'PAP',
  // Barbados
  TBPB:'BGI',
  // Trinidad & Tobago
  TTPP:'POS', TTCP:'TAB',
  // St Lucia
  TLPC:'SLU', TLPL:'UVF',
  // Grenada
  TGPY:'GND',
  // St Vincent
  TVSA:'SVD',
  // Antigua
  TAPA:'ANU',
  // St Kitts
  TKPK:'SKB',
  // Dominica
  TDPD:'DOM',
  // BVI
  TUPJ:'EIS',
  // Anguilla
  TQPF:'AXA',

  // ── Central America ─────────────────────────────────────────────────────────
  MPTO:'PTY', MPBO:'BOC', MPHO:'DAV',         // Panama
  MROC:'SJO', MRLB:'LIR',                      // Costa Rica
  MSLP:'SAL',                                   // El Salvador
  MGGT:'GUA', MGPB:'PBR',                       // Guatemala
  MHLM:'SAP', MHRO:'RTB', MHTG:'TGU',          // Honduras
  MNMG:'MGA', MNBL:'BEF',                       // Nicaragua
  MZBZ:'BZE',                                   // Belize

  // ── South America ───────────────────────────────────────────────────────────
  // Argentina
  SAEZ:'EZE', SABE:'AEP', SAME:'MDZ', SARI:'IGR',
  SAZR:'RSA', SAWH:'USH', SARC:'CNQ',
  // Brazil
  SBGR:'GRU', SBKP:'VCP', SBBR:'BSB', SBGL:'GIG',
  SBRJ:'SDU', SBSP:'CGH', SBPA:'POA', SBSV:'SSA',
  SBRF:'REC', SBFZ:'FOR', SBCF:'CNF', SBFL:'FLN',
  SBCT:'CWB', SBEG:'MAO', SBBE:'BEL', SBMQ:'MCP',
  SBIZ:'IMP', SBCY:'CGB', SBLO:'LDB', SBGO:'GYN',
  // Chile
  SCEL:'SCL', SCIE:'CCP', SCTE:'PMC', SCFA:'ANF',
  SCDA:'IQQ', SCIP:'IPC',
  // Peru
  SPJC:'LIM', SPHO:'AQP', SPZO:'CUZ', SPQL:'JAU',
  // Ecuador
  SEQM:'UIO', SEGU:'GYE', SENL:'GYE',
  // Colombia
  SKBO:'BOG', SKCL:'CLO', SKRG:'MDE', SKSM:'SMR',
  SKLT:'LET', SKPE:'PEI', SKBQ:'BAQ',
  // Venezuela
  SVMI:'CCS', SVBC:'BLA', SVVL:'VLN',
  // Bolivia
  SLLP:'LPB', SLVR:'VVI',
  // Uruguay
  SUAA:'MVD',
  // Paraguay
  SGAS:'ASU',
  // Guyana / Suriname / French Guiana
  SYEC:'GEO', SMJP:'PBM', SOCA:'CAY',

  // ── Europe ──────────────────────────────────────────────────────────────────
  // United Kingdom
  EGLL:'LHR', EGKK:'LGW', EGGW:'LTN', EGSS:'STN',
  EGCC:'MAN', EGPH:'EDI', EGPF:'GLA', EGNT:'NCL',
  EGNX:'EMA', EGGD:'BRS', EGBB:'BHX', EGAA:'BFS',
  EGNM:'LBA', EGHI:'SOU',
  // Ireland
  EIDW:'DUB', EINN:'SNN', EIKN:'NOC',
  // Netherlands
  EHAM:'AMS', EHEH:'EIN', EHRD:'RTM',
  // Belgium
  EBBR:'BRU', EBCI:'CRL',
  // France
  LFPG:'CDG', LFPO:'ORY', LFML:'MRS', LFLL:'LYS',
  LFBO:'TLS', LFMN:'NCE', LFRN:'RNS', LFBD:'BOD',
  LFRS:'NTE', LFST:'SXB', LFMT:'MPL', LFRB:'BES',
  // Germany
  EDDF:'FRA', EDDM:'MUC', EDDB:'BER', EDDL:'DUS',
  EDDH:'HAM', EDDK:'CGN', EDDS:'STR', EDDP:'LEJ',
  EDDN:'NUE', EDDV:'HAJ', EDDC:'DRS',
  // Spain
  LEMD:'MAD', LEBL:'BCN', LEPA:'PMI', LEVC:'VLC',
  LEMG:'AGP', LEBB:'BIO', LEZL:'SVQ', LEAL:'ALC',
  LEGE:'GRO', LEGR:'GRX', LEIB:'IBZ', LEMH:'MAH',
  // Canary Islands (Spain)
  GCLP:'LPA', GCTS:'TFS', GCXO:'TFN', GCLA:'SPC',
  GCFV:'FUE', GCRR:'ACE', GCGM:'GMZ',
  // Italy
  LIRF:'FCO', LIMC:'MXP', LIME:'BGY', LIMF:'TRN',
  LIPZ:'VCE', LIRN:'NAP', LICC:'CTA', LICJ:'PMO',
  LIRQ:'FLR', LIPE:'BLQ', LIBR:'BRI', LIBD:'BRI',
  LIRA:'CIA', LIRP:'PSA',
  // Portugal
  LPPT:'LIS', LPFR:'FAO', LPPR:'OPO', LPPD:'PDL',
  LPLA:'TER', LPFL:'FLW', LPGR:'GRW',
  // Azores / Madeira
  LPMA:'FNC',
  // Switzerland
  LSZH:'ZRH', LSGG:'GVA', LFSB:'BSL',
  // Austria
  LOWW:'VIE', LOWI:'INN', LOWL:'LNZ',
  // Denmark
  EKCH:'CPH', EKBI:'BLL',
  // Sweden
  ESSA:'ARN', ESGG:'GOT', ESMS:'MMX', ESCM:'UME',
  // Norway
  ENGM:'OSL', ENBR:'BGO', ENZV:'SVG', ENVA:'TRD',
  // Finland
  EFHK:'HEL', EFTU:'TKU', EFOU:'OUL',
  // Iceland
  BIKF:'KEF', BIRK:'REK',
  // Czech Republic
  LKPR:'PRG', LKTB:'BRQ',
  // Poland
  EPWA:'WAW', EPKK:'KRK', EPGD:'GDN', EPWR:'WRO',
  EPPO:'POZ', EPRZ:'RZE',
  // Hungary
  LHBP:'BUD',
  // Romania
  LROP:'OTP', LRCL:'CLJ',
  // Bulgaria
  LBSF:'SOF', LBWN:'VAR',
  // Croatia
  LDZA:'ZAG', LDSP:'SPU', LDDV:'DBV',
  // Serbia
  LYBE:'BEG',
  // Slovenia
  LJLJ:'LJU',
  // Slovakia
  LZIB:'BTS', LZKZ:'KSC',
  // Greece
  LGAV:'ATH', LGTS:'SKG', LGKR:'CFU', LGRP:'RHO',
  LGIR:'HER', LGMK:'JMK', LGSA:'CHQ',
  // Cyprus
  LCLK:'LCA', LCPH:'PFO',
  // Turkey
  LTFM:'IST', LTAI:'AYT', LTBS:'DLM', LTBJ:'ADB',
  LTBA:'SAW', LTAC:'ESB',
  // Russia (major routes)
  UUEE:'SVO', UUDD:'DME', UUWW:'VKO', URRR:'ROV',
  UWWW:'KUF', USSS:'SVX', UNNT:'OVB',
  // Ukraine
  UKBB:'KBP', UKLL:'LWO',
  // Lithuania / Latvia / Estonia
  EYVI:'VNO', EVRA:'RIX', EETN:'TLL',
  // Other Europe
  LYBE:'BEG', LDZA:'ZAG', LQSA:'SJJ',

  // ── Middle East ─────────────────────────────────────────────────────────────
  OMDB:'DXB', OMAA:'AUH', OMSJ:'SHJ', OMFJ:'FJR',  // UAE
  OBBI:'BAH',                                          // Bahrain
  OEDF:'DMM', OEJN:'JED', OERK:'RUH',                // Saudi Arabia
  OTHH:'DOH', OTBD:'DOH',                             // Qatar
  OKKK:'KWI', OKBK:'KWI',                            // Kuwait
  OOMS:'MCT', OOSA:'SLL',                             // Oman
  OIIE:'IKA', OIII:'THR',                             // Iran
  LLBG:'TLV', LLIB:'ETH',                             // Israel
  OJAM:'AMM', OJAI:'AQJ',                             // Jordan
  OLBA:'BEY',                                          // Lebanon
  OSDI:'DAM',                                          // Syria
  ORBI:'BGW', ORMM:'BSR',                             // Iraq
  OYAA:'ADN', OYIB:'GXF',                             // Yemen

  // ── Africa ──────────────────────────────────────────────────────────────────
  // South Africa
  FAOR:'JNB', FACT:'CPT', FALE:'DUR', FABL:'BFN',
  // Ethiopia
  HAAB:'ADD',
  // Kenya
  HKJK:'NBO', HKMO:'MBA',
  // Nigeria
  DNMM:'LOS', DNAA:'ABV', DNEN:'ENU',
  // Egypt
  HECA:'CAI', HEGN:'HRG', HESH:'SSH', HEAX:'ALY',
  // Tunisia
  DTTA:'TUN', DTTJ:'DJE',
  // Algeria
  DAAG:'ALG', DAOO:'ORN',
  // Morocco
  GMMN:'CMN', GMME:'RBA', GMML:'TNG', GMFF:'FEZ',
  GMMX:'RAK',
  // Ghana
  DGAA:'ACC',
  // Senegal
  GOBD:'DSS',
  // Ivory Coast
  DIAP:'ABJ',
  // Cameroon
  FKYS:'NSI',
  // Tanzania
  HTDA:'DAR', HTKJ:'JRO',
  // Uganda
  HUEN:'EBB',
  // Rwanda
  HRYR:'KGL',
  // Mozambique
  FQMA:'MPM',
  // Zimbabwe
  FVHA:'HRE',
  // Zambia
  FLLS:'LUN',
  // Madagascar
  FMMI:'TNR',
  // Mauritius
  FIMP:'MRU',

  // ── Asia ────────────────────────────────────────────────────────────────────
  // Japan
  RJAA:'NRT', RJTT:'HND', RJBB:'KIX', RJOO:'ITM',
  RJFF:'FUK', RJCC:'CTS', RJSN:'KIJ', RJOA:'HIJ',
  RJOS:'OKJ', ROAH:'OKA',
  // South Korea
  RKSI:'ICN', RKSS:'GMP', RKPK:'PUS', RKJJ:'CJU',
  // China
  ZBAA:'PEK', ZBAD:'PKX', ZSPD:'PVG', ZSSS:'SHA',
  ZGGG:'CAN', ZGSZ:'SZX', ZUUU:'CTU', ZUCK:'CKG',
  ZLXY:'XIY', ZGHA:'CSX', ZHHH:'WUH', ZSNJ:'NKG',
  ZSAM:'XMN', ZSFZ:'FOC', ZLLL:'LHW', ZPPP:'KMG',
  ZBYN:'TYN', ZBOW:'BAV', ZUGY:'KWE', ZHHH:'WUH',
  // Hong Kong / Macau / Taiwan
  VHHH:'HKG', VMMC:'MFM',
  RCTP:'TPE', RCSS:'TSA', RCKH:'KHH', RCFN:'TTT',
  // Southeast Asia
  WSSS:'SIN', WMKK:'KUL', WMKP:'PEN', WBKK:'BKI',
  RPLL:'MNL', RPVP:'PPS', RPVM:'CEB',
  VTBS:'BKK', VTBD:'DMK', VTSP:'HKT', VTCC:'CNX',
  VVNB:'HAN', VVTS:'SGN', VVDA:'DAD',
  WIII:'CGK', WIDD:'BTH', WADD:'DPS', WRRR:'DPS',
  WMSA:'SZB', WBKW:'BWN',
  VDPP:'PNH', VLVT:'VTE', VYYY:'RGN',
  // India
  VIDP:'DEL', VABB:'BOM', VOBL:'BLR', VOHS:'HYD',
  VOMM:'MAA', VECC:'CCU', VOCI:'COK', VAAH:'AMD',
  VOCL:'CCJ', VIAG:'AGR', VIBN:'VNS', VIGO:'GOP',
  VILK:'LKO', VEPT:'PAT', VEBS:'IXB', VECC:'CCU',
  // Sri Lanka
  VCBI:'CMB',
  // Pakistan
  OPKC:'KHI', OPLA:'LHE', OPIS:'ISB', OPPS:'PEW',
  // Bangladesh
  VGHS:'DAC',
  // Nepal
  VNKT:'KTM',
  // Maldives
  VRMM:'MLE',
  // Central Asia
  UAAA:'ALA', UTTT:'TAS', UTDD:'DYU',

  // ── Australia & Pacific ─────────────────────────────────────────────────────
  YSSY:'SYD', YMML:'MEL', YBBN:'BNE', YPPH:'PER',
  YPAD:'ADL', YBCG:'OOL', YMHB:'HBA', YSCB:'CBR',
  YBMC:'MCY', YBTL:'TSV', YBCS:'CNS', YDNI:'DRW',
  NZAA:'AKL', NZWN:'WLG', NZCH:'CHC', NZQN:'ZQN',
  NFFN:'NAN',                                  // Fiji
  NTAA:'PPT',                                  // Tahiti
  NGFU:'FUN',                                  // Tuvalu
  PKWA:'KWA',                                  // Marshall Islands
};

// ── msgType → status (case-insensitive keys stored lowercase) ─────────────────
const MSG_STATUS = {
  departure              : 'Departed',
  arrival                : 'Arrived',
  cancellation           : 'Cancelled',
  trackinformation       : 'Airborne',
  boundarycrossingupdate : 'Airborne',
  boundary               : 'Airborne',
  oceanic                : 'Airborne',
  flightcreate           : 'Scheduled',
  flightmodify           : 'Scheduled',
  flightplanamendment    : 'Scheduled',
  beaconcode             : 'Scheduled',
  coordination           : 'Scheduled',
  ncsmflightmodify       : 'Scheduled',
  ncsmflightcreate       : 'Scheduled',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function aptIata(icao) {
  if (!icao) return null;
  const c = icao.trim().toUpperCase();
  if (c.length === 3) return c;
  if (APT[c]) return APT[c];
  if (c.length === 4 && c[0] === 'K') return c.slice(1);
  return c;
}

function normalizeAcid(acid) {
  if (!acid) return null;
  const u = acid.trim().toUpperCase();
  if (/^N\d/.test(u)) return null;             // GA tail — skip
  if (/^[A-Z]{2}\d/.test(u)) return u;         // already IATA (UA440)
  const iata = AIRLINE[u.slice(0, 3)];
  return iata ? iata + u.slice(3) : u;
}

// Extract XML attribute value from a tag's attribute string
function attr(s, name) {
  const m = s.match(new RegExp('\\b' + name + '="([^"]*)"', 'i'));
  return m ? m[1] : null;
}

// Extract text content from an XML element (handles namespace prefixes)
function celem(xml, localName) {
  const re = new RegExp('<(?:[a-zA-Z]+:)?' + localName + '(?:\\s[^>]*)?>([^<]+)<\\/(?:[a-zA-Z]+:)?' + localName + '>', 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

// Extract attribute from an XML element (handles namespace prefixes)
function celemAttr(xml, localName, attrName) {
  const re = new RegExp('<(?:[a-zA-Z]+:)?' + localName + '[^>]*\\b' + attrName + '="([^"]*)"', 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

// Parse ISO or FAA compact time string → ISO UTC string
function parseTime(val) {
  if (!val) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(val)) {
    const d = new Date(val.endsWith('Z') ? val : val + 'Z');
    return isNaN(d) ? null : d.toISOString();
  }
  // FAA compact: 0415T1430 (MMDDTHHMM)
  if (/^\d{4}T\d{4}$/.test(val)) {
    const yr = new Date().getUTCFullYear();
    const d = new Date(`${yr}-${val.slice(0,2)}-${val.slice(2,4)}T${val.slice(5,7)}:${val.slice(7,9)}:00Z`);
    return isNaN(d) ? null : d.toISOString();
  }
  return null;
}

// Convert DMS lat or lon from XML to decimal degrees
function parseDMS(xml, axisName) {
  const re = new RegExp('<(?:[a-zA-Z]+:)?' + axisName + 'DMS[^>]+degrees="(\\d+)"[^>]+direction="([^"]+)"[^>]+minutes="(\\d+)"[^>]+seconds="(\\d+)"', 'i');
  const m = xml.match(re);
  if (!m) return null;
  const dec = parseInt(m[1]) + parseInt(m[3]) / 60 + parseInt(m[4]) / 3600;
  const neg = /^[SW]/i.test(m[2]);
  return Math.round((neg ? -dec : dec) * 100000) / 100000;
}

// ── Main parser ───────────────────────────────────────────────────────────────

async function parseTfmMessage(xml) {
  if (!xml) return [];
  const events = [];

  // Match each fltdMessage element including its child content
  const re = /<[^>\s]*fltdMessage\s([^>]*?)>([\s\S]*?)<\/[^>\s]*fltdMessage>/gs;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tagAttrs  = m[1];   // attributes on the fltdMessage opening tag
    const childXml  = m[2];   // child element content

    // ── Identity from tag attributes ────────────────────────────────────────
    const acid    = attr(tagAttrs, 'acid');
    if (!acid) continue;
    const flight  = normalizeAcid(acid);
    if (!flight) continue;

    const msgType = (attr(tagAttrs, 'msgType') || '').toLowerCase();
    const ts      = attr(tagAttrs, 'sourceTimeStamp') || attr(tagAttrs, 'sourceTimestamp') || '';
    const status  = MSG_STATUS[msgType] || 'Scheduled';

    // Airports — prefer tag attrs, fall back to child elements
    const depIcao = attr(tagAttrs, 'depArpt') || celem(childXml, 'departurePoint')?.replace(/[^A-Z]/gi,'') || null;
    const arrIcao = attr(tagAttrs, 'arrArpt') || celem(childXml, 'arrivalPoint')?.replace(/[^A-Z]/gi,'') || null;
    const dep     = aptIata(depIcao);
    const arr     = aptIata(arrIcao);

    // ── Scheduled times (IGTD = Initial Gate Time of Departure) ─────────────
    const igtd          = parseTime(celem(childXml, 'igtd'));
    const scheduled_dep = igtd;

    // Use IGTD as the flight date — sourceTimeStamp is when FAA sent the message,
    // not when the flight departs. Without this, a flightCreate filed on Apr 5
    // for an Apr 6 departure gets stored under Apr 5 and never matches a search.
    const date = igtd ? igtd.slice(0, 10) : (ts ? ts.slice(0, 10) : new Date().toISOString().slice(0, 10));

    // ETA from trackInformation or ncsm blocks: <nxcm:eta etaType="ESTIMATED" timeValue="..."/>
    const etaVal        = celemAttr(childXml, 'eta', 'timeValue');
    const scheduled_arr = parseTime(etaVal);

    // ── Aircraft info ────────────────────────────────────────────────────────
    const aircraftCategory = celemAttr(childXml, 'qualifiedAircraftId', 'aircraftCategory')
      || celemAttr(childXml, 'qualifiedAircraftId', 'userCategory')
      || null;
    const acType =
      celem(childXml, 'flightAircraftSpecs')
      || attr(tagAttrs, 'acType')
      || attr(tagAttrs, 'equipment')
      || aircraftCategory
      || null;

    // ── Current position (trackInformation) ─────────────────────────────────
    const altitude = parseInt(celem(childXml, 'simpleAltitude') || '0') || null;
    const speed    = parseInt(celem(childXml, 'speed') || '0') || null;
    const lat      = parseDMS(childXml, 'latitude');
    const lon      = parseDMS(childXml, 'longitude');
    const posTime  = parseTime(celem(childXml, 'timeAtPosition'));

    // ── Unique flight identifier ─────────────────────────────────────────────
    const gufi = celem(childXml, 'gufi') || null;

    // Registration / tail when present (TFM namespaces)
    const tail_number =
      celem(childXml, 'registration')
      || celem(childXml, 'aircraftRegistration')
      || null;

    // FAA message metadata (fltdMessage attributes + ncsm child status)
    const faa_flight_ref = attr(tagAttrs, 'flightRef') || null;
    const tfm_msg_type = attr(tagAttrs, 'msgType') || null;
    const tfm_fd_trigger = attr(tagAttrs, 'fdTrigger') || null;
    const srcTsRaw = attr(tagAttrs, 'sourceTimeStamp') || attr(tagAttrs, 'sourceTimestamp') || '';
    const tfm_source_timestamp = srcTsRaw ? (parseTime(srcTsRaw) || srcTsRaw) : null;
    const airline_icao = attr(tagAttrs, 'airline') || acid.slice(0, 3) || null;
    const ncsm_flight_status = (celem(childXml, 'flightStatus') || '').trim() || null;

    events.push({
      flight,
      date,
      dep_airport:   dep,
      arr_airport:   arr,
      status,
      scheduled_dep,
      scheduled_arr,
      gate_out:      null,   // OOOI — requires SFDPS subscription
      wheels_off:    null,
      wheels_on:     null,
      gate_in:       null,
      dep_gate:      null,
      arr_gate:      null,
      dep_terminal:  null,
      arr_terminal:  null,
      dep_delay_min: 0,
      arr_delay_min: 0,
      altitude,
      speed,
      latitude:      lat,
      longitude:     lon,
      position_time: posTime,
      gufi,
      tail_number,
      aircraft_type: acType,
      faa_flight_ref,
      tfm_msg_type,
      tfm_fd_trigger,
      tfm_source_timestamp,
      ncsm_flight_status,
      aircraft_category: aircraftCategory,
      airline_icao,
      raw_xml:       m[0].slice(0, 2000),
    });
  }

  return events;
}

module.exports = { parseTfmMessage };
