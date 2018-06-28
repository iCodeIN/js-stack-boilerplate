// @flow

import 'babel-polyfill'
import { PORT, isProd } from '_server/env'

import React from 'react'
import http from 'http'
import ReactDOMServer from 'react-dom/server'
import { matchPath, StaticRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { createStore } from 'redux'
import Koa from 'koa'
import compress from 'koa-compress'
import favicon from 'koa-favicon'
import mount from 'koa-mount'
import Router from 'koa-router'
import serveStatic from 'koa-static'
import Helmet from 'react-helmet'
import serialize from 'serialize-javascript'
import graphqlHTTP from 'koa-graphql'
// flow-disable-next-line
import { buildSchema } from 'graphql'
import bcrypt from 'bcrypt'

import redis from '_db/redis'
import { notesPageConfig } from 'note/note-config'
import { allPageRoutes } from '_shared/shared-config'
import { fetchGraphQL } from '_shared/api-calls'
import { createUser, findUserByUsername } from 'user/user-db'

import App from 'app/app'

// CALL knex.destroy at sigint

const notes = [{ id: '123', name: 'Medor' }, { id: '456', name: 'Max' }]

const graphqlSchema = buildSchema(`
  type Note {
    id: ID!
    name: String
  }

  type Query {
    notes: [Note]
    note(id: ID!): Note
  }
`)

const protect = (fn: Function) => (vars, ctx, ...rest) => {
  console.log(ctx.session)
  return fn(vars, ctx, ...rest)
}

const root = {
  notes: protect(() => notes),
  note: protect(({ id }) => notes.find(d => d.id === id)),
}

const getGeneralData = ctx => ({
  username: 'Sven',
})

const main = async () => {
  const app = new Koa()
  const router = new Router()

  router.all(
    '/graphql',
    graphqlHTTP({
      schema: graphqlSchema,
      rootValue: root,
      graphiql: true,
    }),
  )

  router.post('/signup', async ctx => {
    const { username, password } = ctx.request.body
    if (!username || username === '' || !password || password === '') {
      renderPage(ctx, {
        prefill: ctx.request.body,
        errorMessage: 'Please enter a username and a password.',
      })
    } else {
      const passwordHash = await bcrypt.hash(password, 12)
      await createUser({ username, passwordHash })
      ctx.redirect(notesPageConfig.route.path)
    }
  })

  router.post('/login', async ctx => {
    const { username, password } = ctx.request.body
    const user = await findUserByUsername(username)
    if (user && (await bcrypt.compare(password, user.passwordHash))) {
      ctx.session.user = user
      ctx.redirect(notesPageConfig.route.path)
    } else {
      renderPage(ctx, {
        prefill: ctx.request.body,
        errorMessage: 'Incorrect username or password.',
      })
    }
  })

  router.get('/logout', ctx => {
    ctx.session = null
    ctx.redirect('/')
  })

  router.get('/500', () => {
    throw Error('Fake Internal Server Error')
  })

  router.get('*', async (ctx, next) => {
    let match = {}

    const activeRoute: Object =
      allPageRoutes.find(route => {
        match = matchPath(ctx.req.url, route)
        return match
      }) || {}

    if (ctx.req.url.startsWith('/static')) {
      next()
      return
    }

    const queryVariables = activeRoute.getVariables && activeRoute.getVariables(match.params)
    let pageData

    try {
      pageData = activeRoute.query ? await fetchGraphQL(activeRoute.query, queryVariables) : {}
    } catch (err) {
      ctx.redirect('/unauthorized')
      return
    }

    const store = createStore(() => ({ page: pageData, general: getGeneralData(ctx) }))
    const appHtml = ReactDOMServer.renderToString(
      <Provider store={store}>
        <StaticRouter location={ctx.req.url} context={{}}>
          <App />
        </StaticRouter>
      </Provider>,
    )
    const helmet = Helmet.renderStatic()

    ctx.body = `<!doctype html>
    <html ${helmet.htmlAttributes.toString()}>
      <head>
        <meta charset="utf-8">
        ${helmet.title.toString()}
        ${helmet.meta.toString()}
        ${helmet.link.toString()}
      </head>
      <body ${helmet.bodyAttributes.toString()}>
        <div id="app">${appHtml}</div>
        <script>window.__PRELOADED_STATE__ = ${serialize(store.getState())}</script>
        <script src="/static/js/bundle.js"></script>
      </body>
    </html>`
  })

  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (err) {
      ctx.status = err.status || 500
      ctx.body = err.message
      ctx.app.emit('error', err, ctx)
    }
  })

  app.on('error', (err, ctx) => {
    console.error(err)
  })

  app
    .use(compress())
    .use(mount('/static', serveStatic('dist')))
    .use(mount('/static', serveStatic('public')))
    .use(favicon(`./public/img/favicon.ico`))
    .use(router.routes())
    .use(router.allowedMethods())

  const server = http.createServer(app.callback())
  console.log(`Server now listenning on port ${PORT} (${isProd ? 'production' : 'development'})`)
  server.listen(PORT)
}

main()
