// 整台列表 #/programs：新建一台 / 进入编排 / 删除
import { useEffect, useState } from 'react';
import type { Program } from '../types';
import { deleteProgram, listPrograms, newId, saveProgram } from '../lib/storage';
import { emptyProgram } from '../lib/program';

export function ProgramList() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [title, setTitle] = useState('');

  const refresh = () => listPrograms().then(setPrograms);
  useEffect(() => {
    void refresh();
  }, []);

  const create = async () => {
    const p = emptyProgram(newId('pg'), title.trim() || '未命名一台');
    await saveProgram(p);
    window.location.hash = `#/program/${p.id}`;
  };

  return (
    <div className="page" data-testid="program-list">
      <h1>整台编排</h1>
      <p className="dim">
        把几段锣鼓按顺序接成一台：接缝处拍数不一致自动补一小节过渡（只留强拍的字、其余休止），
        每段按各自速度算出起止时间与总时长；可临时抽段、调顺序，整台一次生成试听，听完可退回编排前。
      </p>
      <div className="create-box">
        <input data-testid="new-program-title" placeholder="台名，如：庙会前场一台" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button className="btn primary" data-testid="btn-create-program" onClick={create}>
          新建一台
        </button>
      </div>

      {programs.length === 0 ? (
        <p className="dim">还没有整台。先在「曲目」里备好各段，再新建一台把它们排起来。</p>
      ) : (
        <table className="list" data-testid="program-table">
          <thead>
            <tr>
              <th>台名</th>
              <th>段数</th>
              <th>参演</th>
              <th>更新</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {programs.map((p) => (
              <tr key={p.id} data-testid={`program-row-${p.id}`}>
                <td>
                  <a href={`#/program/${p.id}`} className="score-link">
                    {p.title}
                  </a>
                </td>
                <td>{p.items.length}</td>
                <td>{p.items.filter((i) => i.included).length}</td>
                <td className="dim">{new Date(p.updatedAt).toLocaleString('zh-CN')}</td>
                <td>
                  <button
                    className="mini danger"
                    data-testid={`del-program-${p.id}`}
                    onClick={async () => {
                      if (confirm(`删除整台「${p.title}」？（不会删除各段曲目）`)) {
                        await deleteProgram(p.id);
                        void refresh();
                      }
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
