export function deepClone<T>(obj: any, excludeFields?: string[]) {
  if (obj === null || typeof obj !== 'object') { return obj }
  if (Object.prototype.toString.call(obj) === '[object Array]') {
    return obj.map((item: any) => deepClone(item, excludeFields))
  }
  const newObj: any = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (!excludeFields || excludeFields.indexOf(key) === -1) {
        newObj[key] = deepClone(obj[key], excludeFields)
      }
    }
  }
  return newObj
}
