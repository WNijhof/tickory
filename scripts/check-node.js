// Draait vóór "npm test": Tickory vraagt Node 26 of nieuwer (zie "engines" in package.json). Met een oudere Node geeft
// "node --test" een cryptische fout over mappen die geen module zijn; dit zegt het gewoon.
const needed = 26;
const have = Number(process.versions.node.split('.')[0]);
if (have < needed) {
  console.error(`Tickory vraagt Node ${needed} of nieuwer; dit is Node ${process.versions.node}. Installeer een nieuwere Node en probeer opnieuw.`);
  console.error(`Tickory needs Node ${needed} or newer; this is Node ${process.versions.node}.`);
  process.exit(1);
}
