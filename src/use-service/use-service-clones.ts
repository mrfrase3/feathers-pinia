import { StorageMapUtils, useServiceStorage } from './use-service-storage'
// import { copyAssociations } from '../utils'
import { AnyData, CloneOptions } from './types'
import fastCopy from 'fast-copy'
import { _ } from '@feathersjs/commons'

export type UseServiceClonesOptions<M extends AnyData> = {
  itemStorage: StorageMapUtils
  tempStorage?: StorageMapUtils
  onRead?: (item: M) => M
  beforeWrite?: (item: M) => M
}

export const useServiceClones = <M extends AnyData>(options: UseServiceClonesOptions<M>) => {
  const { itemStorage, tempStorage, onRead, beforeWrite } = options
  const cloneStorage = useServiceStorage({
    getId: (item) => (tempStorage ? itemStorage.getId(item) || tempStorage.getId(item) : itemStorage.getId(item)),
    onRead,
    beforeWrite,
  })

  /**
   * Fast-copies the provided `item`, placing it in `cloneStorage`.
   * @param item the object to clone.
   * @param data an object to be merged before storing in cloneStorage.
   * @param options.useExisting {Boolean} allows using the existing clone instead of re-cloning.
   * @returns
   */
  function clone(item: M, data = {}, options: CloneOptions = {}): M {
    const originalItem = tempStorage ? tempStorage.get(item) || itemStorage.get(item) : itemStorage.get(item)
    const existingClone = cloneStorage.get(item)

    if (existingClone) {
      if (options.useExisting) return existingClone as M
      return reset(item, data) as M
    } else {
      const copy = fastCopy(originalItem || item) as M

      // copyAssociations(originalItem, copy, copy.getModel().associations)
      Object.assign(copy, data)
      const clone = cloneStorage.set(copy)
      return clone as M
    }
  }

  /**
   * If the `item` has an id, it's merged or written to the itemStore.
   * If the `item` does not have an id, it's merged or written to the tempStore.
   * @param item
   * @param data
   * @returns stored item or stored temp
   */
  function commit(item: M, data: Partial<M> = {}) {
    const itemId = itemStorage.getId(item)
    const _item = Object.assign(fastCopy(item), data)
    // copyAssociations(clone, newOriginal, clone.getModel().associations)
    if (itemId || !tempStorage) {
      itemStorage.merge(_item)
      return itemStorage.get(_item)
    } else {
      tempStorage.merge(_item)
      return tempStorage.get(_item)
    }
  }

  /**
   * If a clone exists, resets the clone to match the item or temp
   * If a clone does not exist, writes the item as the clone.
   * @param item
   * @param data
   * @returns
   */
  function reset(item: M, data = {}) {
    const storage = itemStorage.has(item) || !tempStorage ? itemStorage : tempStorage
    const existingStored = storage.get(item)
    if (existingStored) {
      const copied = fastCopy(existingStored)
      const picked = _.pick(copied, ...Object.keys(existingStored)) as M
      cloneStorage.merge(Object.assign(picked, data))
    } else {
      const copied = fastCopy(item)
      cloneStorage.set(copied)
    }
    return cloneStorage.get(item)
  }

  return {
    cloneStorage,
    clone,
    commit,
    reset,
  }
}
