import * as path from 'node:path'

import { recursiveMerge, taroJsMiniComponentsPath } from '@tarojs/helper'
import { isObject, PLATFORM_TYPE } from '@tarojs/shared'

import { getPkgVersion } from '../utils/package'
import TaroPlatform from './platform'

import type { RecursiveTemplate, UnRecursiveTemplate } from '@tarojs/shared/dist/template'
import type { TConfig } from '../utils/types'

interface IFileType {
  templ: string
  style: string
  config: string
  script: string
  xs?: string
}

export abstract class TaroPlatformBase<T extends TConfig = TConfig> extends TaroPlatform<T> {
  platformType = PLATFORM_TYPE.MINI

  abstract globalObject: string
  abstract fileType: IFileType
  abstract template: RecursiveTemplate | UnRecursiveTemplate
  // Note: 给所有的小程序平台一个默认的 taroComponentsPath
  taroComponentsPath: string = taroJsMiniComponentsPath
  projectConfigJson?: string

  private projectConfigJsonOutputPath: string

  /**
   * 1. 清空 dist 文件夹
   * 2. 输出编译提示
   * 3. 生成 project.config.json
   */
  private async setup () {
    await this.setupTransaction.perform(this.setupImpl, this)
    this.ctx.onSetupClose?.(this)
  }

  private setupImpl () {
    const { output } = this.config
    // webpack5 原生支持 output.clean 选项，但是 webpack4 不支持， 为统一行为，这里做一下兼容
    // （在 packages/taro-mini-runner/src/webpack/chain.ts 和 packages/taro-webpack-runner/src/utils/chain.ts 的 makeConfig 中对 clean 选项做了过滤）
    // 仅 output.clean 为 false 时不清空输出目录
    // eslint-disable-next-line eqeqeq
    if (output == undefined || output.clean == undefined || output.clean === true) {
      this.emptyOutputDir()
    } else if (isObject(output.clean)) {
      this.emptyOutputDir(output.clean.keep || [])
    }
    this.printDevelopmentTip(this.platform)
    if (this.projectConfigJson) {
      this.generateProjectConfig(this.projectConfigJson)
    }
    if (this.ctx.initialConfig.logger?.quiet === false) {
      const { printLog, processTypeEnum } = this.ctx.helper
      printLog(processTypeEnum.START, '开发者工具-项目目录', `${this.ctx.paths.outputPath}`)
    }
    // Webpack5 代码自动热重载
    if (this.compiler === 'webpack5' && this.config.isWatch && this.projectConfigJsonOutputPath) {
      try {
        const projectConfig = require(this.projectConfigJsonOutputPath)
        if (projectConfig.setting?.compileHotReLoad === true) {
          this.ctx.modifyWebpackChain(({ chain }) => {
            chain.plugin('TaroMiniHMRPlugin')
              .use(require(path.join(__dirname, './webpack/hmr-plugin.js')).default)
          })
        }
      } catch (e) {} // eslint-disable-line no-empty
    }
  }

  protected printDevelopmentTip (platform: string) {
    const tips: string[] = []
    const config = this.config
    const { chalk } = this.helper

    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
      const { isWindows } = this.helper
      const exampleCommand = isWindows
        ? `$ set NODE_ENV=production && taro build --type ${platform} --watch`
        : `$ NODE_ENV=production taro build --type ${platform} --watch`

      tips.push(chalk.yellowBright(`预览模式生成的文件较大，设置 NODE_ENV 为 production 可以开启压缩。
Example:
${exampleCommand}`))
    }

    if (this.compiler === 'webpack5' && !config.cache?.enable) {
      tips.push(chalk.yellowBright('建议开启持久化缓存功能，能有效提升二次编译速度，详情请参考: https://docs.taro.zone/docs/config-detail#cache。'))
    }

    if (tips.length) {
      console.log(chalk.yellowBright('Tips:'))
      tips.forEach((item, index) => console.log(`${chalk.yellowBright(index + 1)}. ${item}`))
      console.log('\n')
    }
  }

  /**
   * 返回当前项目内的 runner 包
   */
  protected async getRunner () {
    const { appPath } = this.ctx.paths
    const { npm } = this.helper

    const runnerPkg = this.compiler === 'vite' ? '@tarojs/vite-runner' : '@tarojs/webpack5-runner'

    const runner = await npm.getNpmPkg(runnerPkg, appPath)

    return runner.bind(null, appPath)
  }

  /**
   * 准备 runner 参数
   * @param extraOptions 需要额外合入 Options 的配置项
   */
  protected getOptions (extraOptions = {}) {
    const { ctx, globalObject, fileType, template } = this

    const config = recursiveMerge(Object.assign({}, this.config), {
      env: {
        FRAMEWORK: JSON.stringify(this.config.framework),
        TARO_ENV: JSON.stringify(this.platform),
        TARO_PLATFORM: JSON.stringify(this.platformType),
        TARO_VERSION: JSON.stringify(getPkgVersion())
      }
    })

    return {
      ...config,
      nodeModulesPath: ctx.paths.nodeModulesPath,
      buildAdapter: config.platform,
      platformType: this.platformType,
      globalObject,
      fileType,
      template,
      ...extraOptions
    }
  }

  /**
   * 调用 runner 开始编译
   * @param extraOptions 需要额外传入 runner 的配置项
   */
  private async build (extraOptions = {}) {
    this.ctx.onBuildInit?.(this)
    await this.buildTransaction.perform(this.buildImpl, this, extraOptions)
  }

  private async buildImpl (extraOptions = {}) {
    const runner = await this.getRunner()
    const options = this.getOptions(
      Object.assign(
        {
          runtimePath: this.runtimePath,
          taroComponentsPath: this.taroComponentsPath,
          behaviorsName: this.behaviorsName,
        },
        extraOptions
      )
    )
    await runner(options)
  }

  /**
   * 生成 project.config.json
   * @param src 项目源码中配置文件的名称
   * @param dist 编译后配置文件的名称，默认为 'project.config.json'
   */
  protected generateProjectConfig (src: string, dist = 'project.config.json') {
    if (this.config.isBuildNativeComp) return
    this.ctx.generateProjectConfig({
      srcConfigName: src,
      distConfigName: dist
    })
    this.projectConfigJsonOutputPath = `${this.ctx.paths.outputPath}/${dist}`
  }

  /**
   * 递归替换对象的 key 值
   */
  protected recursiveReplaceObjectKeys (obj, keyMap) {
    Object.keys(obj).forEach((key) => {
      if (keyMap[key]) {
        obj[keyMap[key]] = obj[key]
        if (typeof obj[key] === 'object') {
          this.recursiveReplaceObjectKeys(obj[keyMap[key]], keyMap)
        }
        delete obj[key]
      } else if (keyMap[key] === false) {
        delete obj[key]
      } else if (typeof obj[key] === 'object') {
        this.recursiveReplaceObjectKeys(obj[key], keyMap)
      }
    })
  }

  /**
   * 调用 runner 开启编译
   */
  public async start () {
    await this.setup()
    await this.build()
  }
}
