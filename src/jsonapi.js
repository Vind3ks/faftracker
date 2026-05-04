function resourceKey(type, id) {
  return `${type}:${id}`;
}

function buildIncludedIndex(document) {
  const index = new Map();
  for (const resource of document.included || []) {
    index.set(resourceKey(resource.type, resource.id), resource);
  }
  return index;
}

function getRelationshipResources(resource, relationshipName, includedIndex) {
  const rel = resource?.relationships?.[relationshipName]?.data;
  if (!rel) {
    return [];
  }

  const refs = Array.isArray(rel) ? rel : [rel];
  return refs
    .map((ref) => includedIndex.get(resourceKey(ref.type, ref.id)))
    .filter(Boolean);
}

function getRelationshipResource(resource, relationshipName, includedIndex) {
  return getRelationshipResources(resource, relationshipName, includedIndex)[0] || null;
}

module.exports = {
  buildIncludedIndex,
  getRelationshipResource,
  getRelationshipResources
};
