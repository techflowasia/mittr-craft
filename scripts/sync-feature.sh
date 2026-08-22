#!/usr/bin/env bash
set -e

# รับค่าชื่อ feature branch จาก argument
TARGET_FEATURE=$1

if [ -z "${TARGET_FEATURE}" ]; then
    echo "ความผิดพลาด: กรุณาระบุชื่อ feature branch ที่ต้องการรัน"
    echo "ตัวอย่างการใช้งาน: ./scripts/sync-feature.sh feat/auth"
    exit 1
fi

# ตรวจสอบว่า branch ที่ระบุมีอยู่จริงหรือไม่
if ! git rev-parse --verify "${TARGET_FEATURE}" >/dev/null 2>&1; then
    echo "ความผิดพลาด: ไม่พบ branch '${TARGET_FEATURE}' ในระบบ"
    exit 1
fi

# ตรวจสอบชื่อ branch ปัจจุบันเพื่อใช้เป็น Base Branch (เช่น main หรือ build/20260822)
BASE_BRANCH=$(git branch --show-current)

if [ -z "${BASE_BRANCH}" ]; then
    echo "ความผิดพลาด: ไม่พบ branch ปัจจุบัน"
    exit 1
fi

if [ "${BASE_BRANCH}" = "${TARGET_FEATURE}" ]; then
    echo "ความผิดพลาด: branch ปัจจุบัน (${BASE_BRANCH}) และ feature branch เป็นตัวเดียวกัน"
    exit 1
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CLEAN_FEATURE_NAME=$(echo "${TARGET_FEATURE}" | sed 's/\//-/g')
BACKUP_BRANCH="backup/${TIMESTAMP}-${CLEAN_FEATURE_NAME}"

echo "==> 1. สำรองข้อมูล branch ${TARGET_FEATURE} ไว้ที่ ${BACKUP_BRANCH}"
git branch "${BACKUP_BRANCH}" "${TARGET_FEATURE}"

# จัดเก็บงานที่ค้างอยู่ (ถ้ามี)
HAS_STASH=false
if ! git diff-index --quiet HEAD --; then
    echo "==> พบไฟล์ค้างอยู่ กำลังทำการ stash..."
    git stash save "WIP-auto-stash-${TIMESTAMP}"
    HAS_STASH=true
fi

echo "==> 2. อัปเดต base branch (${BASE_BRANCH}) ล่าสุดจาก remote"
git checkout "${BASE_BRANCH}"
git pull origin "${BASE_BRANCH}" || echo "ข้อสังเกต: ไม่สามารถ pull remote '${BASE_BRANCH}' ได้ ใช้ local แทน"

echo "==> 3. ทำการ Squash และ Rebase branch ${TARGET_FEATURE} บน ${BASE_BRANCH}"
git checkout "${TARGET_FEATURE}"

# ย่อ commit ทั้งหมดเข้าหา base branch (พร้อมคัดลอกสคริปต์นี้ไว้ป้องกันการถูกลบ)
git reset --soft "${BASE_BRANCH}"
git commit -m "feat: sync and squash ${TARGET_FEATURE} onto ${BASE_BRANCH}" || echo "ไม่มีความเปลี่ยนแปลงใหม่"

# Rebase บน base branch
git rebase "${BASE_BRANCH}"

echo "==> 4. รวมโค้ดเข้า ${BASE_BRANCH}"
git checkout "${BASE_BRANCH}"
git merge "${TARGET_FEATURE}"

# คืนค่า stash (ถ้ามี)
if [ "${HAS_STASH}" = true ]; then
    echo "==> คืนค่า stash..."
    git stash pop || echo "ข้อสังเกต: การ stash pop มี conflict โปรดตรวจสอบไฟล์ด้วยตนเอง"
fi

echo "==> ดำเนินการอัปเดต ${TARGET_FEATURE} เข้า ${BASE_BRANCH} สำเร็จเรียบร้อย"
