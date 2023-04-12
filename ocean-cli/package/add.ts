import inquirer from 'inquirer'
import Fuse from 'fuse.js'
import inquirerPrompt from 'inquirer-autocomplete-prompt'
import { find, isEmpty } from 'lodash'
import axios from 'axios'
import dotenv from 'dotenv'
import chalk from 'chalk'
import ora from 'ora'
import type { packagistData } from '../utils/composer'
import { extract_packagist_detected_compatible_versions, extract_packagist_first_release_at, extract_packagist_latest_release_at } from '../utils/composer'
import { extract_npm_first_release_at, extract_npm_latest_release_at } from '../utils/npm'
import type { NpmData } from '../utils/npm'
import type { GithubData } from '../utils/github'
import { extract_github_stars } from '../utils/github'
import { log } from '../print'
import { readPackagesDatabase, writePackagesDatabase } from '~/ocean-cli/database'
import {
    name as z_name,
    description as z_description,
    github as z_github,
    author as z_author,
    composer as z_composer,
    npm as z_npm,
    php_only as z_php_only,
    keywords as z_keywords,
    laravelPackageSchema } from '~/ocean-cli/validation-rules'
import { categories } from '~/database/categories'
import type { Package } from '~/types/package'

dotenv.config()

// Register the autocomplete prompt
inquirer.registerPrompt('autocomplete', inquirerPrompt)

export const addPackage = async function(){
    const laravelPackages = readPackagesDatabase()
    
    const fuseCategories = new Fuse(categories, {
        minMatchCharLength: 0,
        threshold: 0.2,
    })

    inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Name:',
            validate: (value: string) => {
                const result = z_name.safeParse(value)
                return result.success ? true : result.error.errors.map(error => error.message).join('\n')
            },
            filter: (value: string) => {
                const words = value.split(' ')
                const capitalizedWords = words.map((word) => {
                    return word.charAt(0).toUpperCase() + word.slice(1)
                })
                return capitalizedWords.join(' ')
            },
        },
        {
            type: 'input',
            name: 'description',
            message: 'Description:',
            validate: (value: string) => {
                const result = z_description.safeParse(value)
                return result.success ? true : result.error.errors.map(error => error.message).join('\n')
            },
            filter: (value: string) => {
                // Capitalize the first letter of the description
                // And if the description doesn't end with a period, add one
                return value.charAt(0).toUpperCase() + value.slice(1) + (value.endsWith('.') ? '' : '.')
            },
        },
        {
            type: 'autocomplete',
            name: 'category',
            message: 'Category:',
            source: (answersSoFar: unknown, input = '') => input ? fuseCategories.search(input).map(result => result.item) : categories,
        },
        {
            type: 'input',
            name: 'github',
            message: 'Github:',
            validate: (value: string) => {
                const result = z_github.safeParse(value)
                if(!result.success)
                    return result.error.errors.map(error => error.message).join('\n')
                if(find(laravelPackages, { github: value }))
                    return 'This package is already in the database'

                return true
            },
        },
        {
            type: 'input',
            name: 'author',
            message: 'Author:',
            validate: (value: string) => {
                const result = z_author.safeParse(value)
                return result.success ? true : result.error.errors.map(error => error.message).join('\n')
            },
        },
        {
            type: 'input',
            name: 'composer',
            message: 'Composer(optional, default: null):',
            validate: (value: string) => {
                if(isEmpty(value))
                    return true
                const result = z_composer.safeParse(value)
                if(!result.success)
                    return result.error.errors.map(error => error.message).join('\n')
                if(find(laravelPackages, { composer: value }))
                    return 'This package is already in the database'

                return true
            },
        },
        {
            type: 'input',
            name: 'npm',
            message: 'Npm(optional, default: null):',
            validate: (value: string) => {
                if(isEmpty(value)) return true
                const result = z_npm.safeParse(value)
                if(!result.success)
                    return result.error.errors.map(error => error.message).join('\n')
                if(find(laravelPackages, { npm: value }))
                    return 'This package is already in the database'

                return true
            },
        },
        {
            type: 'confirm',
            name: 'php_only',
            message: 'Is this a PHP only package (does not require Laravel)?',
            default: false,
            validate: (value: boolean) => {
                const result = z_php_only.safeParse(value)
                return result.success ? true : result.error.errors.map(error => error.message).join('\n')
            },
        },
        {
            type: 'input',
            name: 'keywords',
            message: 'Keywords (optional, separate words with comma):',
            validate: (value: string) => {
                if(isEmpty(value)) return true

                const keywords = value.split(',').map(keyword => keyword.trim())

                const result = z_keywords.safeParse(keywords)
                if(!result.success)
                    return result.error.errors.map(error => error.message).join('\n')

                return true
            },
        },
    ])
        .then(
            async(
                answers: Pick<Package,
                    'name' | 'author' | 'category' | 'description' | 'composer' | 'npm' | 'github' | 'php_only'>
                & { keywords: string },
            ) => {
                const newPackage: Package = {
                    name: answers.name,
                    description: answers.description,
                    category: answers.category,
                    github: answers.github,
                    author: answers.author,
                    composer: isEmpty(answers.composer) ? null : answers.composer,
                    npm: isEmpty(answers.npm) ? null : answers.npm,
                    stars: 0,
                    keywords: isEmpty(answers.keywords) ? [] : answers.keywords.split(',').map(keyword => keyword.trim()),
                    first_release_at: '',
                    latest_release_at: '',
                    detected_compatible_versions: [],
                    compatible_versions: [],
                    php_only: answers.php_only,
                    updated_at: new Date().toISOString(),
                    created_at: new Date().toISOString(),
                }

                const spinner = ora('Fetching online information').start()

                if(newPackage.composer){
                    spinner.text = 'Getting packagist data'

                    const { data: packagistData }: { data: packagistData }
                        = await axios.get(`https://packagist.org/packages/${newPackage.composer}.json`)
                    
                    newPackage.first_release_at = extract_packagist_first_release_at(packagistData)
                    newPackage.latest_release_at = extract_packagist_latest_release_at(packagistData)

                    if(!newPackage.php_only){
                        newPackage.detected_compatible_versions = extract_packagist_detected_compatible_versions(packagistData)

                        if (newPackage.detected_compatible_versions.length === 0) 
                            log(chalk.yellow('\n Could not detect any compatible versions \n'))
                    }
                }
                else if(newPackage.npm){
                    spinner.text = 'Getting npm data'
                    
                    const { data: npmData }: { data: NpmData } = await axios.get(`https://registry.npmjs.org/${newPackage.npm}`)
                    newPackage.first_release_at = extract_npm_first_release_at(npmData)
                    newPackage.latest_release_at = extract_npm_latest_release_at(npmData)
                }

                spinner.text = 'Getting github data'

                const { data: githubData }: { data: GithubData } = await axios.get(`https://api.github.com/repos/${newPackage.github.substring(19)}`, {
                    headers: {
                        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                    },
                })

                spinner.text = 'Finished fetching online information.'

                spinner.stop()

                newPackage.stars = extract_github_stars(githubData)

                const validationResult = laravelPackageSchema.safeParse(newPackage)

                if(!validationResult.success) {
                    log(chalk.yellow('Validation failed \n'))
                    log(validationResult.error.errors.map(error => error.message).join('\n'))
                }
                else{
                    // Add the new package to the array
                    laravelPackages.push(newPackage)

                    // Write the new package to the database
                    writePackagesDatabase(laravelPackages)

                    // Show a success message
                    log(chalk.magenta('\n Package has been added! \n'))
                }
            },
        )
}