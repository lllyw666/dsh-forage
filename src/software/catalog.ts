export interface SoftwareLink {
  name: string;
  url: string;
  license: string;
  note?: string;
}

export interface SoftwareEntry {
  id: string;
  name: string;
  aliases: string[];
  purpose: string;
  license: string;
  official?: SoftwareLink;
  freeOptions: SoftwareLink[];
  searchQuery: string;
  verifiedAt: string;
  notes: string[];
}

export const SOFTWARE_DISCLAIMER = [
  "仅提供官方或开源软件的入口，不提供破解、激活绕过、网盘或来源不明的二进制。",
  "dsh-forage 与被推荐软件无隶属关系，不保证其可用性、安全性、许可证或后续更新。",
  "付费软件请自行购买合法许可证；下载前核对官方域名、数字签名和文件哈希。",
  "因使用第三方软件产生的风险由用户自行承担。"
].join("\n");

export const SOFTWARE_CATALOG: SoftwareEntry[] = [
  {
    id: "snapgene",
    name: "SnapGene",
    aliases: ["snapgene", "snapgene viewer", "dna", "plasmid", "载体", "质粒", "图谱"],
    purpose: "打开 .dna 文件、查看/编辑载体并导出质粒图谱 PNG",
    license: "commercial; SnapGene Viewer is a free official viewer (features vary by version)",
    official: {
      name: "SnapGene download",
      url: "https://www.snapgene.com/download",
      license: "commercial",
      note: "Official vendor download; paid license/trial may be required for editing/export."
    },
    freeOptions: [
      {
        name: "SnapGene Viewer",
        url: "https://www.snapgene.com/snapgene-viewer",
        license: "free official viewer",
        note: "Official viewer; verify which export actions the current version permits."
      },
      {
        name: "Benchling",
        url: "https://www.benchling.com/",
        license: "free academic tier / commercial tiers",
        note: "Web-based; verify .dna import and export options."
      },
      {
        name: "ApE (A plasmid Editor)",
        url: "https://jorgensen.biology.utah.edu/wayned/ape/",
        license: "free",
        note: "Desktop plasmid editor; verify SnapGene .dna compatibility."
      },
      {
        name: "UGENE",
        url: "https://ugene.net/",
        license: "open source (GPL)",
        note: "General bioinformatics suite; not a SnapGene-style map clone."
      },
      {
        name: "37degrees Plasmid Map Renderer",
        url: "https://www.37degrees.io/resources/plasmid-map-renderer/",
        license: "free web tool",
        note: "No-login map renderer; verify .dna input support before relying on it."
      }
    ],
    searchQuery: "SnapGene official download",
    verifiedAt: "2026-10-27",
    notes: ["For exact SnapGene-style PNG output, use the official application; AI cannot operate its GUI."]
  },
  {
    id: "benchling",
    name: "Benchling",
    aliases: ["benchling", "web plasmid", "质粒", "载体"],
    purpose: "Web-based molecular biology/plasmid workspace",
    license: "free academic tier / commercial tiers",
    official: {
      name: "Benchling",
      url: "https://www.benchling.com/",
      license: "free academic tier / commercial tiers",
      note: "Verify institutional terms and data policy."
    },
    freeOptions: [],
    searchQuery: "Benchling free academic plasmid editor",
    verifiedAt: "2026-10-27",
    notes: ["Cloud service; check data policy before uploading unpublished sequences."]
  },
  {
    id: "ape",
    name: "ApE (A plasmid Editor)",
    aliases: ["ape", "a plasmid editor", "质粒", "载体"],
    purpose: "Free desktop plasmid editing/viewing",
    license: "free",
    official: {
      name: "ApE",
      url: "https://jorgensen.biology.utah.edu/wayned/ape/",
      license: "free",
      note: "Official author page."
    },
    freeOptions: [],
    searchQuery: "ApE A plasmid Editor official",
    verifiedAt: "2026-10-27",
    notes: []
  },
  {
    id: "ugene",
    name: "UGENE",
    aliases: ["ugene", "bioinformatics", "sequence"],
    purpose: "Open-source bioinformatics suite",
    license: "GPL",
    official: {
      name: "UGENE",
      url: "https://ugene.net/",
      license: "GPL",
      note: "Official project site."
    },
    freeOptions: [],
    searchQuery: "UGENE official download",
    verifiedAt: "2026-10-27",
    notes: []
  },
  {
    id: "biopython",
    name: "Biopython SnapGeneIO",
    aliases: ["biopython", "snapgeneio", "dna parser", "python"],
    purpose: "Programmatically parse SnapGene .dna files",
    license: "BSD-3-Clause / Biopython License",
    official: {
      name: "Biopython SnapGeneIO",
      url: "https://github.com/biopython/biopython/blob/master/Bio/SeqIO/SnapGeneIO.py",
      license: "BSD-3-Clause / Biopython License",
      note: "Library, not a desktop application."
    },
    freeOptions: [],
    searchQuery: "Biopython SnapGeneIO documentation",
    verifiedAt: "2026-10-27",
    notes: ["Requires Python; useful for custom map rendering, not SnapGene-native export."]
  },
  {
    id: "sgffp",
    name: "sgffp",
    aliases: ["sgffp", "snapgene parser", "dna parser"],
    purpose: "SnapGene File Format Parser (Python)",
    license: "check package metadata before use",
    official: {
      name: "sgffp on PyPI",
      url: "https://pypi.org/project/sgffp/",
      license: "check package metadata",
      note: "Third-party parser; review license and maintenance before use."
    },
    freeOptions: [],
    searchQuery: "sgffp SnapGene parser PyPI",
    verifiedAt: "2026-10-27",
    notes: ["Not an official GSL Biotech product."]
  }
];

function haystack(entry: SoftwareEntry): string {
  return [entry.id, entry.name, ...entry.aliases, entry.purpose].join(" ").toLowerCase();
}

export function findSoftware(query = ""): SoftwareEntry[] {
  const value = query.trim().toLowerCase();
  if (value === "") return SOFTWARE_CATALOG;
  return SOFTWARE_CATALOG.filter((entry) => haystack(entry).includes(value)
    || value.split(/\s+/).every((token) => haystack(entry).includes(token)));
}

export function softwareSearchUrl(entry: SoftwareEntry): string {
  return "https://www.google.com/search?q=" + encodeURIComponent(entry.searchQuery);
}

export function validateSoftwareUrl(url: string): boolean {
  return /^https:\/\//i.test(url);
}
