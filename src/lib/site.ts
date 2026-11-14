/** Who built PowerFlow and where its source lives, for the credits on public pages. */
export const AUTHOR = {
  name: "Sriharsha Challangi",
  github: "https://github.com/Devligan",
} as const;

export const SOURCE_REPO = "https://github.com/Devligan/powerflow";

/** A file in the repository on master, for "read the code" links. */
export const sourceUrl = (path: string) => `${SOURCE_REPO}/blob/master/${path}`;
