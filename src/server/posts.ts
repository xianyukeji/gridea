import * as fs from 'fs'
import Model from './model'
import * as fse from 'fs-extra'
import * as path from 'path'
// tslint:disable-next-line
const junk = require('junk')
import { IPost, IPostDb } from './interfaces/post'
import ContentHelper from '../helpers/content-helper'
import matter from 'gray-matter'
import moment from 'moment'
import { deepClone } from '../helpers/utils'

interface IMap {
  key: string,
  reg: RegExp,
  replaceStr: string
  reverseReg: RegExp
}

export default class Posts extends Model {
  postDir: string
  postImageDir: string

  constructor(appInstance: any) {
    super(appInstance)
    this.postDir = path.join(this.appDir, 'posts')
    this.postImageDir = `${this.appDir}/post-images`
  }


  /**
   * readdir postDir and make config file for post
   * - polyfill for tags (tags is string)
   * - polyfill for gray-matter
   * - data formate
   */
  public async savePosts() {
    const translateBeforeMatter = (str: string) => {
      // fixed bug #43
      const titleLineMatch = str.match(/title:.*/)
      if (titleLineMatch) {
        const titleLine = titleLineMatch[0]
        const titleLineContentMatch = titleLine.match(/(?<=title:\s*)\S.*/)
        if (titleLineContentMatch) {
          const [content] = titleLineContentMatch
          const [startChar, endChar] = [content.slice(0, 1), content.slice(-1)]
          const [conditionA, conditionB] = [
            startChar === `'` && endChar === `'`,
            startChar === `"` && endChar === `"`,
          ]

          let replaceContent: string

          if (!conditionA && !conditionB) {
            replaceContent = `'` + content + `'`
          } else {
            // `'let's go'` => `'let''s go'`
            replaceContent = content.replace(/(?<=\w.[^\'])\'/g, (p, l) => {
              return content[l + 1] === `'` ? `'` : `''`
            })
          }

          const length: number = 20
          const charArray = new Array(length).fill(0).map((item: any, index: number) => `'`.repeat(index * 2)).reverse()
          charArray.forEach((char) => {
            if (replaceContent.startsWith(char)) {
              replaceContent = replaceContent.replace(new RegExp(`^${char}`), char.slice(-1))
            }
            if (replaceContent.endsWith(char)) {
              replaceContent = replaceContent.replace(new RegExp(`${char}$`), char.slice(-1))
            }
          })
          str = str.replace(titleLine, 'title: ' + replaceContent)
        }
      }

      // fixed tag is string
      const tagsMatch = str.match(/tags:.*/)
      if (tagsMatch) {
        const tagsStr = tagsMatch[0]

        if (!['[', ']'].some((d: any) => tagsStr.includes(d))) {
          const tags = tagsStr.replace(/tags:\s*/, '').split(' ')
          str = str.replace(tagsStr, `tags: ${JSON.stringify(tags)}`)
        }
      }
      return str
    }

    const translateAfterMatter = (postMatter: any, fileName: string) => {
      const postMatterClone = deepClone(postMatter)
      const { data } = postMatterClone

      if (data && data.title) {
        data.title = data.title.toString()
      }

      if (data && data.date) {
        if (typeof data.date === 'string') {
          data.date = moment(data.date).format('YYYY-MM-DD HH:mm:ss')
        } else {
          data.date = moment(data.date).subtract(8, 'hours').format('YYYY-MM-DD HH:mm:ss')
        }
      }

      const moreReg = /\n\s*<!--\s*more\s*-->\s*\n/i
      const matchMore = moreReg.exec(postMatterClone.content)
      if (matchMore) {
        postMatterClone.abstract = (postMatterClone.content).substring(0, matchMore.index) // Abstract
      }

      if (postMatterClone.data.published === undefined) {
        postMatterClone.data.published = false
      }

      // Articles migrated from other platforms or old articles do not have `hideInList` fields
      if (postMatterClone.data.hideInList === undefined) {
        postMatterClone.data.hideInList = false
      }

      delete postMatterClone.orig // Remove orig <Buffer>

      return {
        abstract: '',
        ...postMatterClone,
        fileName,
      }
    }

    let files = await fse.readdir(this.postDir)
    files = files.filter(junk.not)

    const results = await Promise.all(files.map((item) => fs.readFileSync(path.join(this.postDir, item), 'utf8')))

    const resultList: any = await Promise.all(results.map(async (result: any, index: any) => {
      result = translateBeforeMatter(result)

      if (!matter.test(result)) {
        throw new Error('matter error')
      }
      const postMatter = matter(result)

      const fileName = files[index].substring(0, files[index].length - 3) // To be optimized!
      return translateAfterMatter(postMatter, fileName)
    }))

    resultList.sort((a: any, b: any) => moment(b.data.date).unix() - moment(a.data.date).unix())

    this.$posts.set('posts', resultList).write()
    return true
  }

  async list() {
    await this.savePosts()
    // await this.$posts.defaults({ posts: [] }).write()
    const posts = await this.$posts.get('posts').value()
    const helper = new ContentHelper()

    const list = posts.map((post: IPostDb) => {
      const item = JSON.parse(JSON.stringify(post))
      item.content = helper.changeImageUrlDomainToLocal(item.content, this.appDir)
      item.data.feature = item.data.feature
        ? item.data.feature.includes('http')
          ? item.data.feature
          : helper.changeFeatureImageUrlDomainToLocal(item.data.feature, this.appDir)
        : item.data.feature
      return item
    })

    return list
  }


  /**
   * Save Post to file
   * @param post
   */
  async savePostToFile(post: IPost): Promise<IPost | null> {
    const helper = new ContentHelper()
    const content = helper.changeImageUrlLocalToDomain(post.content, this.db.setting.domain)
    const extendName = (post.featureImage.name || 'jpg').split('.').pop()

    const mdStr = `---
title: ${post.title}
date: ${post.date}
tags: [${post.tags.join(',')}]
published: ${post.published}
hideInList: ${post.hideInList}
feature: ${post.featureImage.name ? `/post-images/${post.fileName}.${extendName}` : post.featureImagePath}
---
${content}`

    try {

      // If exist feature image
      if (post.featureImage.path) {

        const filePath = `${this.postImageDir}/${post.fileName}.${extendName}`

        if (post.featureImage.path !== filePath) {
          await fse.copySync(post.featureImage.path, filePath)

          // Clean the old file
          if (post.featureImage.path.includes(this.postImageDir)) {
            await fse.removeSync(post.featureImage.path)
          }
        }
      }

      // Write file must use fse, beause fs.writeFile need callback
      await fse.writeFile(`${this.postDir}/${post.fileName}.md`, mdStr)

      // Clean the old file
      if (post.deleteFileName) {
        await fse.removeSync(`${this.postDir}/${post.deleteFileName}.md`)
      }
    } catch (e) {
      console.error('ERROR: ', e)
    }
    return post
  }

  async deletePost(post: IPostDb) {
    try {
      const postUrl = `${this.postDir}/${post.fileName}.md`
      await fse.removeSync(postUrl)

      // Clean feature image
      if (post.data.feature) {
        await fse.removeSync(post.data.feature.replace('file://', ''))
      }

      // Clean post content image
      const imageReg = /(!\[.*?\]\()(.+?)(\))/g
      const imageList = post.content.match(imageReg)
      if (imageList) {
        const postImagePaths = imageList.map((item: string) => {
          const index = item.indexOf('(')
          return item.substring(index + 1, item.length - 1)
        })
        postImagePaths.forEach(async (filePath: string) => {
          await fse.removeSync(filePath.replace('file://', ''))
        })
      }
      return true
    } catch (e) {
      console.error('Delete Error', e)
      return false
    }
  }

  async uploadImages(files: any[]) {
    await fse.ensureDir(this.postImageDir)
    const results = []
    for (const file of files) {
      const extendName = file.name.split('.').pop()
      const newFileName = new Date().getTime()
      const filePath = `${this.postImageDir}/${newFileName}.${extendName}`
      await fse.copySync(file.path, filePath)
      results.push(filePath)
    }
    return results
  }
}
