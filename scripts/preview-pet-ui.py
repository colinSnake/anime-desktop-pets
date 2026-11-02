#!/usr/bin/env python3
"""离屏生成菜单与气泡的深浅色预览，不显示桌面窗口、不读取真实用户配置。"""
import os,tempfile,sys,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=root/'.local/pet-build/previews/cards';out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='dragon-card-preview-') as home:
 os.environ.update(HOME=home,BAILONG_DATA_DIR=home,QT_QPA_PLATFORM='offscreen',BAILONG_CODEX='/usr/bin/false')
 sys.path[:0]=[str(root/'apps/pet-runtime/bailong'),str(root/'.local/pet-build/generated-source/app')]
 from PySide6.QtWidgets import QApplication,QStyleFactory
 from PySide6.QtGui import QPalette,QColor
 from PySide6.QtCore import QPoint
 from pet import Pet
 from dragon_ui import Bubble
 from PIL import Image,ImageDraw,ImageFont
 app=QApplication([]);app.setStyle(QStyleFactory.create('macOS'))
 pet=Pet()
 for theme in ['light','dark']:
  if theme=='dark':
   palette=QPalette(app.palette());palette.setColor(QPalette.ColorRole.Window,QColor('#242426'));palette.setColor(QPalette.ColorRole.WindowText,QColor('#fafafa'));palette.setColor(QPalette.ColorRole.Text,QColor('#fafafa'));app.setPalette(palette)
  menu=pet.context_menu();menu.popup(QPoint(20,20));menu.setActiveAction(next(a for a in menu.actions() if a.isCheckable()));app.processEvents();menu.grab().save(str(out/f'menu-{theme}.png'))
  submenu=next(a.menu() for a in menu.actions() if a.menu() and a.menu().title()=='互动差分动画');submenu.popup(QPoint(300,20));submenu.setActiveAction(submenu.actions()[0]);app.processEvents();submenu.grab().save(str(out/f'submenu-{theme}.png'));submenu.hide();menu.hide()
  activity=next(a.menu() for a in menu.actions() if a.menu() and a.menu().title()=='自主活动');activity.popup(QPoint(300,20));app.processEvents();activity.grab().save(str(out/f'activity-{theme}.png'));activity.hide()
  bubble=Bubble()
  bubble.message('主人，我在这里。');app.processEvents();bubble.grab().save(str(out/f'message-short-{theme}.png'));print(theme,'short',bubble.size().toTuple())
  bubble.message('第一行：完整显示换行\n第二行：紧凑卡片布局\n第三行：长内容可滚动');app.processEvents();bubble.grab().save(str(out/f'message-lines-{theme}.png'));print(theme,'multiline',bubble.size().toTuple())
  bubble.task_result('任务已完成','已更新菜单和气泡样式。',lambda:None);app.processEvents();bubble.grab().save(str(out/f'result-short-{theme}.png'))
  bubble.task_result('任务进度','这是一段较长的进度记录，超出阅读区时滚动查看。\n'*30,lambda:None);app.processEvents();bubble.grab().save(str(out/f'result-long-{theme}.png'));print(theme,'long',bubble.size().toTuple())
  bubble.quota([{'name':'5小时','remaining':76,'resetsAt':1793463780},{'name':'一周','remaining':91,'resetsAt':1793816400}]);app.processEvents();bubble.grab().save(str(out/f'quota-{theme}.png'));print(theme,'quota',bubble.size().toTuple())
  bubble.message('完成。');app.processEvents();print(theme,'shrink',bubble.size().toTuple());bubble.close()
 pet.close()
 font=ImageFont.truetype('/System/Library/Fonts/SFNS.ttf',15)
 sheet=Image.new('RGB',(1140,1080),'#e8e9ed');draw=ImageDraw.Draw(sheet)
 for theme,y in [('light',0),('dark',540)]:
  if theme=='dark':draw.rectangle((0,y,1140,y+540),fill='#171719')
  fg='#eeeef0' if theme=='dark' else '#303034'
  draw.text((24,y+12),f'{theme.title()} / Card UI / offscreen',fill=fg,font=font)
  for name,x,dy in [('menu',20,44),('submenu',220,44),('message-short',435,44),('message-lines',435,110),('result-short',770,44),('result-long',770,170),('quota',20,270)]:
   im=Image.open(out/f'{name}-{theme}.png').convert('RGBA');sheet.paste(im,(x,y+dy),im)
 sheet.save(out/'card-ui-preview.png')
 print(out/'card-ui-preview.png')
