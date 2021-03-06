const path = require('path')
const { EventEmitter } = require('events')
const { promisify } = require('util')
const fs = require('fs-extra')
const glob = require('fast-glob')
const chalk = require('chalk')
const slash = require('slash')
const debug = require('debug')('saber')
const loadConfig = require('./utils/loadConfig')
const pathToRoute = require('./utils/pathToRoute')
const localRequire = require('./utils/localRequire')
const pathToComponentName = require('./utils/pathToComponentName')

const handleRoute = route => {
  if (route.endsWith('.html')) {
    return route
  }
  return route.replace(/\/?$/, '/index.html')
}

class Saber extends EventEmitter {
  constructor(baseDir, opts = {}) {
    super()
    this.baseDir = path.resolve(baseDir || '.')
    loadConfig.options.cwd = this.baseDir
    localRequire.setOptions({ baseDir: this.baseDir })

    this.configureServerFns = new Set()
    this.enhanceAppFiles = new Set(['#app/enhance-app.js'])
    this.routes = new Set()
    this.chainWebpackFns = new Set()

    const { data: config } = loadConfig.loadSync()
    this.options = this.normalizeOptions(Object.assign({}, opts, config))
  }

  normalizeOptions(opts = {}) {
    const options = Object.assign(
      {
        host: '0.0.0.0',
        port: 4000,
        outDir: '.saber',
        staticDir: 'static',
        pagesDir: 'pages',
        root: '/'
      },
      opts
    )

    options.outDir = path.resolve(this.baseDir, options.outDir)
    options.staticDir = path.resolve(this.baseDir, options.staticDir)
    options.pagesDir = path.resolve(this.baseDir, options.pagesDir)

    if (options.enhanceAppFiles) {
      for (const file of options.enhanceAppFiles) {
        this.enhanceAppFiles.add(file)
      }
    }

    if (options.chainWebpack) {
      this.chainWebpackFns.add(options.chainWebpack)
    }

    if (options.configureServer) {
      this.configureServerFns.add(options.configureServer)
    }

    return options
  }

  chainWebpack(fn) {
    this.chainWebpackFns.add(fn)
    return this
  }

  configureServer(fn) {
    this.configureServerFns.add(fn)
    return this
  }

  resolveOutDir(...args) {
    return path.resolve(this.options.outDir, ...args)
  }

  resolveAppDir(...args) {
    return path.join(__dirname, 'app', ...args)
  }

  resolvePagesDir(...args) {
    return path.join(this.options.pagesDir, ...args)
  }

  createClientConfig() {
    const config = require('./webpack/webpack.client')(this)
    for (const fn of this.chainWebpackFns) {
      fn(config, { type: 'client' })
    }
    if (this.options.debugWebpack) {
      console.log('client webpack config', config.toString())
    }
    return config
  }

  createServerConfig() {
    const config = require('./webpack/webpack.server')(this)
    for (const fn of this.chainWebpackFns) {
      fn(config, { type: 'server' })
    }
    if (this.options.debugWebpack) {
      console.log('server webpack config', config.toString())
    }
    return config
  }

  loadPlugins() {
    let plugins = this.options.plugins || []

    if (Object.prototype.toString.call(plugins) === '[object Object]') {
      plugins = Object.keys(plugins).map(name => [name, plugins[name]])
    }

    plugins = [
      [
        path.join(__dirname, 'plugins/google-analytics'),
        this.options.googleAnalytics
      ],
      [path.join(__dirname, 'plugins/pwa'), this.options.pwa],
      ...plugins
    ]

    const isFile = v => path.isAbsolute(v) || v.startsWith('.')

    plugins = plugins.map(plugin => {
      const [name, options] = [].concat(plugin)
      return localRequire.require(
        isFile(name) ? name : name.replace(/^(saber-plugin-)?/, 'saber-plugin-')
      )(options)
    })

    this.plugins = plugins
  }

  applyPlugins() {
    for (const plugin of this.plugins) {
      plugin.apply(this)
    }
  }

  async prepare({ dev }) {
    this.dev = dev
    this.loadPlugins()
    this.applyPlugins()
    await fs.emptyDir(this.resolveOutDir())
    await Promise.all([this.prepareRoutes(), this.prepareApp()])
  }

  getWebpackConfigForESLint() {
    this.dev = true
    this.loadPlugins()
    this.applyPlugins()
    return this.createClientConfig().toConfig()
  }

  async prepareRoutes() {
    debug('loading pages from file system')
    const pattens = ['**/*.vue', '!**/_*']
    const cwd = this.resolvePagesDir()
    const files = await glob(pattens, { cwd }).then(res => new Set(res))

    for (const file of files) {
      debug(`add route for file: ${file}`)
      this.routes.add(pathToRoute(file))
    }
    await this.writeRoutes(files)

    if (this.dev) {
      const watcher = require('chokidar').watch(pattens, {
        cwd,
        ignoreInitial: true
      })

      watcher.on('add', file => {
        debug(`add route for file: ${file}`)
        files.add(file)
        this.routes.add(pathToRoute(file))
        this.writeRoutes(files).catch(console.error)
      })

      watcher.on('unlink', file => {
        debug(`remove route for file: ${file}`)
        files.delete(file)
        this.routes.delete(pathToRoute(file))
        this.writeRoutes(files).catch(console.error)
      })
    }
  }

  async writeRoutes(files) {
    let routes = [...files].map(file => ({
      path: pathToRoute(file, false),
      component: `#pages/${slash(file)}`,
      name: pathToComponentName(file)
    }))

    const groupChildren = (routes, depth = 1) => {
      for (const route of routes) {
        const RE = new RegExp(`^${'/[^/]+'.repeat(depth)}/index$`)
        if (route.path === '/index') {
          route.path = '/'
        } else if (RE.test(route.path)) {
          const parentRoutePath = route.path.replace(/\/index$/, '')
          const parentRoute = routes.find(
            route => route.path === parentRoutePath
          )
          if (parentRoute) {
            const childRoutes = []
            routes = routes.filter(route => {
              const isChild = route.path.startsWith(`${parentRoutePath}/`)

              if (isChild) {
                childRoutes.push(
                  Object.assign({}, route, {
                    childPath: route.path.replace(
                      new RegExp(`^${parentRoutePath}/(index)?`),
                      ''
                    )
                  })
                )
              }
              return !isChild
            })
            parentRoute.children = parentRoute.children || []
            parentRoute.children = parentRoute.children.concat(
              groupChildren(childRoutes, depth + 1)
            )
          }
        }
      }

      return routes
    }

    routes = groupChildren(routes)

    const routesTemplate = require('./app/templates/routes')
    const outFile = this.resolveOutDir('templates/routes.js')
    await fs.ensureDir(path.dirname(outFile))
    await fs.writeFile(outFile, routesTemplate(routes), 'utf8')
  }

  async prepareApp() {
    const appTemplate = require('./app/templates/app')
    const outFile = this.resolveOutDir('templates/app.js')
    await fs.ensureDir(path.dirname(outFile))
    await fs.writeFile(outFile, appTemplate(this), 'utf8')
  }

  async develop() {
    await this.prepare({ dev: true })

    const clientConfig = this.createClientConfig()
    const app = require('express')()

    for (const fn of this.configureServerFns) {
      fn(app)
    }

    if (this.options.proxy) {
      for (const p of Object.keys(this.options.proxy)) {
        app.use(p, require('http-proxy-middleware')(this.options.proxy[p]))
      }
    }

    const history = require('connect-history-api-fallback')
    app.use(
      history({
        verbose: this.options.debug,
        rewrites: [{ from: /\.html$/, to: '/index.html' }]
      })
    )

    const compiler = require('webpack')(clientConfig.toConfig())
    require('webpack-hot-client')(compiler, {
      logLevel: 'error'
    })
    app.use(
      require('webpack-dev-middleware')(compiler, {
        logLevel: 'error',
        publicPath: compiler.options.output.publicPath
      })
    )
    app.listen(this.options.port, this.options.host)
  }

  async build() {
    await this.prepare({ dev: false })

    const clientCompiler = require('webpack')(
      this.createClientConfig().toConfig()
    )
    const serverCompiler = require('webpack')(
      this.createServerConfig().toConfig()
    )

    const [clientStats, serverStats] = await Promise.all([
      promisify(clientCompiler.run.bind(clientCompiler))(),
      promisify(serverCompiler.run.bind(serverCompiler))()
    ])

    if (!clientStats.hasErrors() && !serverStats.hasErrors()) {
      await this.generate()
    }
  }

  async generate() {
    const { createBundleRenderer } = require('vue-server-renderer')

    const template = await fs.readFile(
      this.resolveAppDir('index.prod.html'),
      'utf-8'
    )
    const serverBundle = require(this.resolveOutDir(
      'dist/server/saber-server.json'
    ))
    const clientManifest = require(this.resolveOutDir(
      'dist/client/saber-client.json'
    ))
    const renderer = createBundleRenderer(serverBundle, {
      template,
      clientManifest,
      basedir: this.baseDir,
      inject: false,
      runInNewContext: true
    })

    await fs.copy(
      this.resolveOutDir('dist/client'),
      this.resolveOutDir('website')
    )
    await fs.remove(this.resolveOutDir('website/saber-client.json'))

    const extraRoutes = new Set()

    const generateRoutes = async routes => {
      await Promise.all(
        [...routes].map(async route => {
          console.log(`> Generating ${route}`)
          const context = {
            url: route,
            addRoute: route => extraRoutes.add(route)
          }
          const html = await renderer.renderToString(context)
          const outFile = path.join(
            this.resolveOutDir('website'),
            handleRoute(route)
          )
          await fs.ensureDir(path.dirname(outFile))
          await fs.writeFile(outFile, html, 'utf8')
        })
      )
    }

    await generateRoutes(this.routes)
    await generateRoutes(extraRoutes)

    this.emit('generated')
    console.log(
      `> Done, ${chalk.green(
        path.relative(process.cwd(), this.resolveOutDir('website'))
      )} is ready to be deployed!`
    )
  }
}

module.exports = (...args) => new Saber(...args)
