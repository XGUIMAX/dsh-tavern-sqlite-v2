#!/usr/bin/env node
// V2现场区块装卸：Linux一次定位直接写入，不检查/修改既有VM旗标；运行兼容仍按Release说明。
// adapter 只暴露块机制四件套 + 有限 targets：**无 uninstallAllSeams**——旧 legacy 施缝链不再由本入口消费。
import {applyStandardSeams,checkStandardSeams,uninstallStandardSeams,inspectStandardSeamsPlan,prepareStandardSeams,writePreparedStandardSeams,restorePreparedStandardSeams,maintenanceTargets} from './standard-seams.mjs'
import {runCli} from './maintenance/runner.mjs'
export const maintenanceAdapter=Object.freeze({
 packageName:'dsh-tavern-sqlite-v2',line:'v2',execution:'server-vm-esm',requiresVmModules:true,
 ownedId:'dsh-tavern-storage-author-host-v2',hostMarker:'[dsh-tavern-core-host:v1]',otherHostMarker:'[dsh-tavern-v1-storage-host:v1]',
 targets:maintenanceTargets,applyStandardSeams,checkStandardSeams,uninstallStandardSeams,inspectStandardSeamsPlan,
 prepareStandardSeams,writePreparedStandardSeams,restorePreparedStandardSeams,
})
runCli(import.meta.url,maintenanceAdapter)
