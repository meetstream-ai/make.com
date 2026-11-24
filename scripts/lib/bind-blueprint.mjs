// Custom app modules use the app# prefix in Make's own scenario exports.
// Keep the account-specific app name outside the distributable drafts.
export function bindBlueprint(blueprint, appId, { crmJsonStructureId, calendarDataStoreId, summaryDataStoreId } = {}) {
  if (typeof appId !== 'string' || !/^[a-z][0-9a-z-]+[0-9a-z]$(?![\s\S])/.test(appId)) {
    throw new Error('Use the immutable app ID shown in the Make Apps Editor URL');
  }
  if (crmJsonStructureId !== undefined && (!Number.isSafeInteger(crmJsonStructureId) || crmJsonStructureId <= 0)) {
    throw new Error('The CRM JSON data structure ID must be a positive safe integer');
  }
  if (calendarDataStoreId !== undefined && (!Number.isSafeInteger(calendarDataStoreId) || calendarDataStoreId <= 0)) {
    throw new Error('The calendar data store ID must be a positive safe integer');
  }
  if (summaryDataStoreId !== undefined && (!Number.isSafeInteger(summaryDataStoreId) || summaryDataStoreId <= 0)) {
    throw new Error('The summary data store ID must be a positive safe integer');
  }
  const bound = structuredClone(blueprint);
  const visit = flow => {
    for (const module of flow) {
      if (module.module?.startsWith('app#meetstream:')) {
        module.module = `app#${appId}:${module.module.slice('app#meetstream:'.length)}`;
      }
      if (module.module === 'json:CreateJSON' && module.id === 22 && crmJsonStructureId !== undefined) {
        module.parameters = { ...module.parameters, type: crmJsonStructureId };
      }
      if (module.module?.startsWith('datastore:') && module.parameters?.datastore === 'SUMMARY_DATA_STORE_ID') {
        if (summaryDataStoreId !== undefined) module.parameters = { ...module.parameters, datastore: summaryDataStoreId };
      } else if (module.module?.startsWith('datastore:') && module.parameters?.datastore === undefined && calendarDataStoreId !== undefined) {
        module.parameters = { ...module.parameters, datastore: calendarDataStoreId };
      }
      for (const route of module.routes || []) visit(route.flow);
      if (module.onerror) visit(module.onerror);
    }
  };
  visit(bound.flow);
  return bound;
}
