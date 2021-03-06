import config from 'config';
import client from '../client';
import { buildQuery } from '../queryBuilder';
import bodybuilder from 'bodybuilder'
import esResultsProcessor from './processor'
import { getIndexName } from '../mapping'
// @ts-ignore
import { getCurrentPlatformConfig } from '../../../../platform/helpers'
import { list as listProductReviews } from '../review/resolver'
import { adjustQuery, getResponseObject } from '@storefront-api/lib/elastic'
import { aggregationsToAttributes } from '../attribute/aggregations'

const resolver = {
  Query: {
    products: (_, { search, filter, sort, currentPage, pageSize, _sourceIncludes, _sourceExcludes }, context, rootValue) =>
      list({ filter, sort, currentPage, pageSize, search, context, rootValue, _sourceIncludes, _sourceExcludes }),
    product: (_, { sku, id, url_path, _sourceIncludes, _sourceExcludes }, context, rootValue) =>
      listSingleProduct({ sku, id, url_path, context, rootValue, _sourceIncludes, _sourceExcludes })
  },
  Products: {
    items: async (_, { search }, context, rootValue) => { return _.items } // entry point for product extensions
  },
  BundleOptionLink: {
    product: (_, params, context, rootValue) =>
      listSingleProduct({ sku: _.sku, context, rootValue })
  },
  Product: {
    reviews: (_, { search, filter, currentPage, pageSize, sort, _sourceIncludes, _sourceExcludes }, context, rootValue) => {
      return listProductReviews({ search, filter: Object.assign({}, filter, { product_id: { in: _.id } }), currentPage, pageSize, sort, context, rootValue, _sourceIncludes, _sourceExcludes })
    },
    categories: listProductCategories,
    /* TODO: We can extend our resolvers to meet the Magento2 GraphQL data model easily
    breadcrumbs: (_, { search }, context, rootValue) => {
      return _.category
    },
    price_range: (_, { search }, context, rootValue) => {
      return {
        minimum_price: {
          regular_price: {},
          final_price: {},
          discount: {}
        },
        maximum_price: {
          regular_price: {},
          final_price: {},
          discount: {}
        }
      }
    }, */
    media_gallery: (_, { search }, context, rootValue) => {
      if (_.media_gallery) {
        return _.media_gallery.map(mItem => {
          return {
            image: mItem.image,
            vid: mItem.vid,
            typ: mItem.typ,
            url: `${getCurrentPlatformConfig().imgUrl}${mItem.image}`,
            label: mItem.lab,
            video: mItem.vid,
            type: mItem.typ
          }
        })
      } else {
        return []
      }
    } // entry point for product extensions
  }
};

async function listProductCategories (_, { search }, context, rootValue) {
  const categoryIds = _.category.map(item => item.category_id)
  const catQuery = {
    index: getIndexName(context.req.url),
    type: 'category',
    body: bodybuilder().filter('terms', 'id', categoryIds).build()
  }
  const response = getResponseObject(await client.search(adjustQuery(catQuery, 'category', config)))
  return response.hits.hits.map(el => {
    return el._source
  })
}

export async function listSingleProduct ({ sku, id = null, url_path = null, context, rootValue, _sourceIncludes = null, _sourceExcludes = null }) {
  const filter = {}
  if (sku) filter['sku'] = { eq: sku }
  if (id) filter['id'] = { eq: id }
  if (url_path) filter['url_path'] = { eq: url_path }
  const productList = await list({ filter, pageSize: 1, context, rootValue, _sourceIncludes, _sourceExcludes })
  if (productList && productList.items.length > 0) {
    return productList.items[0]
  } else {
    return null
  }
}

export async function list ({ filter, sort = null, currentPage = null, pageSize, search = null, context, rootValue, _sourceIncludes = null, _sourceExcludes = null }) {
  let _req = {
    query: {
      _source_excludes: _sourceExcludes,
      _source_includes: _sourceIncludes
    }
  }

  let query = buildQuery({
    filter: filter,
    sort: sort,
    currentPage: currentPage,
    pageSize: pageSize,
    search: search,
    type: 'product'
  });

  let esIndex = getIndexName(context.req.url)

  let response = getResponseObject(await client.search(adjustQuery({
    index: esIndex,
    type: 'product',
    body: query,
    _source_includes: _sourceIncludes,
    _source_excludes: _sourceExcludes
  }, 'product', config)));
  if (response && response.hits && response.hits.hits) {
    // process response result (caluclate taxes etc...)
    response.hits.hits = await esResultsProcessor(response, _req, 'product', esIndex);
  }

  // Process hits
  response.items = []
  response.hits.hits.forEach(hit => {
    let item = hit._source
    item._score = hit._score
    response.items.push(item)
  });

  response = await aggregationsToAttributes(response, config, esIndex)
  response.total_count = response.hits.total

  // Process sort
  let sortOptions = []
  for (var sortAttribute in sort) {
    sortOptions.push(
      {
        label: sortAttribute,
        value: sortAttribute
      }
    )
  }
  response.sort_fields = {}
  if (sortOptions.length > 0) {
    response.sort_fields.options = sortOptions
  }

  response.page_info = {
    page_size: pageSize,
    current_page: currentPage
  }

  return response;
}

export default resolver;
