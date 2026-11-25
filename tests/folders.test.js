import { describe, it, expect } from 'vitest';
import folders from '../src/lib/folders.js';

const { emptyFolders, normalizeFolders, addFolder, renameFolder, removeFolder, assignToFolder, folderOf, folderChatCounts, pruneFolders } = folders;

function withFolders(...names) {
  let data = emptyFolders();
  const made = [];
  for (const name of names) {
    const result = addFolder(data, name);
    data = result.data;
    made.push(result.folder);
  }
  return { data, made };
}

describe('folders', () => {
  it('adds as many folders as asked, each with its own id', () => {
    const { data, made } = withFolders(...Array.from({ length: 25 }, (_, i) => `Folder ${i + 1}`));
    expect(data.folders).toHaveLength(25);
    expect(new Set(made.map((folder) => folder.id)).size).toBe(25);
  });

  it('tidies the name and gives back the existing folder for a name already in use', () => {
    const first = addFolder(emptyFolders(), '  Client   work ');
    expect(first.folder.name).toBe('Client work');
    const again = addFolder(first.data, 'client work');
    expect(again.folder).toEqual(first.folder);
    expect(again.data.folders).toHaveLength(1);
    expect(() => addFolder(first.data, '   ')).toThrow('Give the folder a name');
  });

  it('does not change the data it was given', () => {
    const start = emptyFolders();
    addFolder(start, 'Work');
    expect(start).toEqual({ folders: [], chats: {}, projects: {} });
  });

  it('files chats and projects, one folder each, and takes them out again', () => {
    const { data, made: [work, home] } = withFolders('Work', 'Home');
    let filed = assignToFolder(data, 'chats', ['c-1', 'c-2'], work.id);
    filed = assignToFolder(filed, 'projects', ['p-1'], home.id);
    filed = assignToFolder(filed, 'chats', ['c-2'], home.id); // moving replaces the old folder
    expect(folderOf(filed, 'chats', 'c-1')).toEqual(work);
    expect(folderOf(filed, 'chats', 'c-2')).toEqual(home);
    expect(folderOf(filed, 'projects', 'p-1')).toEqual(home);

    const out = assignToFolder(filed, 'chats', ['c-1'], null);
    expect(folderOf(out, 'chats', 'c-1')).toBeNull();
    expect(() => assignToFolder(filed, 'chats', ['c-1'], 'gone')).toThrow('That folder no longer exists');
  });

  it('renames a folder but refuses a name another folder has', () => {
    const { data, made: [work, home] } = withFolders('Work', 'Home');
    expect(renameFolder(data, work.id, 'Clients').folders[0]).toEqual({ id: work.id, name: 'Clients' });
    expect(() => renameFolder(data, work.id, 'home')).toThrow('There is already a folder called "Home"');
    expect(renameFolder(data, home.id, 'HOME').folders[1].name).toBe('HOME'); // its own name in another case is fine
  });

  it('removing a folder unfiles what was in it and deletes nothing else', () => {
    const { data, made: [work, home] } = withFolders('Work', 'Home');
    let filed = assignToFolder(data, 'chats', ['c-1'], work.id);
    filed = assignToFolder(filed, 'chats', ['c-2'], home.id);
    filed = assignToFolder(filed, 'projects', ['p-1'], work.id);
    const after = removeFolder(filed, work.id);
    expect(after.folders).toEqual([home]);
    expect(after.chats).toEqual({ 'c-2': home.id });
    expect(after.projects).toEqual({});
  });

  it('counts the chats in each folder and the ones in none', () => {
    const { data, made: [work, home] } = withFolders('Work', 'Home');
    const filed = assignToFolder(assignToFolder(data, 'chats', ['c-1', 'c-2'], work.id), 'chats', ['gone'], home.id);
    const counts = folderChatCounts(filed, [{ uuid: 'c-1' }, { uuid: 'c-2' }, { uuid: 'c-3' }]);
    expect(counts).toEqual({ '': 1, [work.id]: 2, [home.id]: 0 });
  });

  it('forgets chats and projects that no longer exist', () => {
    const { data, made: [work] } = withFolders('Work');
    const filed = assignToFolder(assignToFolder(data, 'chats', ['c-1', 'c-2'], work.id), 'projects', ['p-1'], work.id);
    const pruned = pruneFolders(filed, ['c-2'], []);
    expect(pruned.chats).toEqual({ 'c-2': work.id });
    expect(pruned.projects).toEqual({});
    expect(pruned.folders).toEqual([work]);
  });

  it('repairs stored data: bad folders and assignments to unknown folders are dropped', () => {
    const data = normalizeFolders({
      folders: [{ id: 'f1', name: 'Work' }, { id: 'f1', name: 'Twice' }, { name: 'No id' }, null],
      chats: { 'c-1': 'f1', 'c-2': 'missing' },
      projects: 'not a map',
    });
    expect(data).toEqual({ folders: [{ id: 'f1', name: 'Work' }], chats: { 'c-1': 'f1' }, projects: {} });
    expect(normalizeFolders(undefined)).toEqual(emptyFolders());
  });
});
