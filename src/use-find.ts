import type { Paginated, Params, Query, QueryInfo } from './types'
import type { ServiceStoreDefault, FindFn, FindClassParamsStandalone, CurrentQuery } from './service-store/types'
import type { MaybeRef } from './utility-types'
import { computed, ComputedRef, isRef, Ref, ref, unref, watch, WritableComputedRef } from 'vue-demi'
import { BaseModel } from './service-store/base-model'
import { usePageData } from './utils-pagination'
import { computedAttr, getQueryInfo, hasOwn, makeUseFindItems } from './utils'
import { _ } from '@feathersjs/commons'

type Store<M extends BaseModel> = ServiceStoreDefault<M>

export function useFind<M extends BaseModel>(params: MaybeRef<FindClassParamsStandalone<M>>) {
  return new Find(params)
}

interface ParamsWithQuery<M extends BaseModel> extends FindClassParamsStandalone<M> {
  query: Query
}

export class Find<M extends BaseModel> {
  params: Ref<ParamsWithQuery<M>>
  store: Store<M>
  paginateOnServer: boolean
  isSsr: ComputedRef<boolean>
  qid: WritableComputedRef<string>

  // Data
  data: ComputedRef<M[]>
  allData: ComputedRef<M[]>
  total: ComputedRef<number>
  limit: Ref<number>
  skip: Ref<number>
  findInStore: (params: Params) => Paginated<M>

  // Queries
  currentQuery: ComputedRef<CurrentQuery<M> | null>
  latestQuery: ComputedRef<QueryInfo | null>
  previousQuery: ComputedRef<QueryInfo | null>

  // Requests & Watching
  find: FindFn<M>
  request: Ref<Promise<Paginated<M>>>
  requestCount: Ref<number>
  queryWhen: (queryWhenFn: () => boolean) => void
  // watchParams: (paramsFn: () => Params | null, watchOptions?: WatchOptions) => void

  // Request State
  isPending: Ref<boolean>
  haveBeenRequested: Ref<boolean>
  haveLoaded: Ref<boolean>
  error: ComputedRef<any>
  clearError: () => void

  // Pagination Utils
  pageCount: Ref<number>
  currentPage: Ref<number>
  canPrev: ComputedRef<boolean>
  canNext: ComputedRef<boolean>
  next: () => Promise<void>
  prev: () => Promise<void>
  toStart: () => Promise<void>
  toEnd: () => Promise<void>
  toPage: (page: number) => Promise<void>

  constructor(_params: MaybeRef<FindClassParamsStandalone<M>>) {
    // If we started without a query, flag `startedWithoutQuery`` then assign an empty query.
    const params = isRef(_params) ? _params : ref(_params)
    const startedWithQuery = hasOwn(params.value, 'query')
    if (!startedWithQuery) params.value.query = {}
    ;(this.store as Store<M>) = params.value.store as Store<M>

    /*** PARAMS ***/
    this.params = params as Ref<ParamsWithQuery<M>>
    this.qid = computedAttr(params.value, 'qid')
    // Set qid to default if it was not passed in the params.
    if (!this.qid.value) this.qid.value = 'default'
    const { immediate = true, watch: _watch = false } = params.value
    const query = computedAttr(this.params, 'query')
    this.limit = computedAttr(query, '$limit')
    this.skip = computedAttr(query, '$skip')
    const paramsWithPagination = computed(() => {
      return {
        ...params.value,
        $limit: this.limit.value,
        $skip: this.skip.value,
      }
    })
    const paramsWithoutPagination = computed(() => {
      const queryShallowCopy = { ...(params.value.query || {}) }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { $limit, $skip, ...query } = queryShallowCopy
      return { ...params.value, query }
    })
    this.paginateOnServer = !!params.value.paginateOnServer
    this.isSsr = computed(() => this.store.isSsr)

    /*** REQUEST STATE ***/
    const isPending = ref(false)
    const haveBeenRequested = ref(false)
    const haveLoaded = ref(false)
    const error = ref(null)
    this.isPending = computed(() => isPending.value)
    this.haveBeenRequested = computed(() => haveBeenRequested.value)
    this.haveLoaded = computed(() => haveLoaded.value)
    this.error = computed(() => error.value)
    this.clearError = () => (error.value = null)

    /*** STORE ITEMS ***/
    const inStore = computed(() => {
      if (isPending.value && this.latestQuery.value && this.paginateOnServer) {
        const { pageParams, queryParams } = this.latestQuery.value as any
        const params = { query: { ...pageParams, ...queryParams }, paginateOnServer: true }
        return makeUseFindItems(this.store, params).value
      }
      return makeUseFindItems(this.store, paramsWithPagination).value
    })
    this.allData = computed(() => this.store.findInStore(paramsWithoutPagination).data)
    this.data = inStore
    this.findInStore = this.store.findInStore

    /*** QUERY WHEN ***/
    let queryWhen = () => true
    this.queryWhen = (queryWhenFn: () => boolean) => {
      queryWhen = queryWhenFn
    }
    // returns cached query data from the store BEFORE the request is sent.
    this.currentQuery = computed(() => {
      const qidState: any = this.store.pagination[this.qid.value]
      if (!qidState) return null
      const queryInfo = getQueryInfo(params.value)
      delete queryInfo.response
      delete queryInfo.isOutdated

      const queryState = qidState[queryInfo.queryId]
      if (!queryState) return null

      const { total } = queryState
      const pageState = queryState[queryInfo.pageId as string]
      if (!pageState) return null

      const { ids, queriedAt } = pageState
      const items = Object.values(_.pick(this.store.itemsById, ...ids))
      const info = { ...queryInfo, ids, items, total, queriedAt } as CurrentQuery<M>
      return info || null
    })

    /*** QUERIES ***/
    const queries: Ref<QueryInfo[]> = ref([]) // query info after the response returns
    this.latestQuery = computed(() => {
      return queries.value[queries.value.length - 1] || null
    })
    this.previousQuery = computed(() => {
      return queries.value[queries.value.length - 2] || null
    })

    /*** PAGINATION DATA ***/
    const storeCount = computed(() => this.store.countInStore(paramsWithoutPagination.value))
    this.total = computed(() => {
      if (this.paginateOnServer) return (this.latestQuery.value as any)?.response.total
      else return storeCount.value
    })
    const pageData = usePageData(this.limit, this.skip, this.total)
    const { pageCount, currentPage, canPrev, canNext } = pageData
    Object.assign(this, { pageCount, currentPage, canPrev, canNext })

    /*** PAGINATION UTILS ***/
    const waitForExistingRequest = async () => {
      if (request.value) await request.value
    }
    this.toStart = () =>
      waitForExistingRequest()
        .then(() => pageData.toStart())
        .then(() => makeRequest())
    this.toEnd = () =>
      waitForExistingRequest()
        .then(() => pageData.toEnd())
        .then(() => makeRequest())
    this.toPage = (page: number) =>
      waitForExistingRequest()
        .then(() => pageData.toPage(page))
        .then(() => makeRequest())
    this.next = () =>
      waitForExistingRequest()
        .then(() => pageData.next())
        .then(() => makeRequest())
    this.prev = () =>
      waitForExistingRequest()
        .then(() => pageData.prev())
        .then(() => makeRequest())

    /*** SERVER FETCHING ***/
    this.requestCount = ref(0)
    this.request = ref(null) as any
    this.find = async (params: MaybeRef<Params> = paramsWithPagination) => {
      const _params = unref(params)
      // if queryWhen is falsey, return early with dummy data
      if (!queryWhen()) {
        return Promise.resolve({ data: [] as M[] } as Paginated<M>)
      }

      this.requestCount.value++
      haveBeenRequested.value = true // never resets
      isPending.value = true
      haveLoaded.value = false
      error.value = null

      try {
        const response = await this.store.find(_params)

        // Set limit and skip if missing
        if ((hasOwn(response, 'limit') && this.limit.value == null) || this.skip.value == null) {
          const res = response as Paginated<M>
          if (this.limit.value === undefined) this.limit.value = res.limit
          if (this.skip.value === undefined) this.skip.value = res.skip
        }
        // Keep the two most-recent queries
        if ((response as Paginated<M>).total) {
          const res = response as Paginated<M>
          const queryInfo = getQueryInfo(paramsWithPagination, res)
          queries.value.push(queryInfo)
          if (queries.value.length > 2) queries.value.shift()
        }
        haveLoaded.value = true

        return response
      } catch (err: any) {
        error.value = err
        throw err
      } finally {
        isPending.value = false
      }
    }

    /*** QUERY WATCHING ***/
    // Keep track if no $limit or $skip was passed so we don't fetch twice when they are set from the response
    let initWithLimitOrSkip = false
    // provide access to the request from inside the watcher
    const request = this.request
    if (this.limit.value || this.skip.value) initWithLimitOrSkip = true

    const makeRequest = async (_params?: Params) => {
      if (!this.paginateOnServer) return

      // Don't make a second request if no limit or skip were provided
      if (this.requestCount.value === 1 && !initWithLimitOrSkip) {
        initWithLimitOrSkip = true
        return
      }
      request.value = this.find(_params || params)
      await request.value
    }

    if (this.paginateOnServer) {
      if (_watch) {
        watch(paramsWithoutPagination, () => makeRequest(), { immediate })
      }
      // If immediate is provided without limit or skip, manually run immediately
      if ((!_watch && immediate) || (immediate && (this.limit.value == null || this.limit.value == null))) {
        makeRequest()
      }
    }

    return this
  }
}
